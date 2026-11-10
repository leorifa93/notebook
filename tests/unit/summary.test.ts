import { APICallError } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { handleChat } from "@/app/api/chat/handler";
import { handleDeleteDocument } from "@/app/api/documents/handler";
import { handleIngest } from "@/app/api/ingest/handler";
import { handleGetSummary, handlePostSummary, type SummaryDeps } from "@/app/api/summary/handler";
import { ConfigError } from "@/lib/env";
import { CONFIG_ERROR_MESSAGE, QUOTA_ERROR_MESSAGE } from "@/lib/errors";
import { SUMMARY_SYSTEM_PROMPT, SYSTEM_PROMPT } from "@/lib/prompt";
import { SUMMARY_RATE_LIMIT } from "@/lib/rate-limit";
import {
  SUMMARY_INPUT_TOKENS,
  SUMMARY_MAX_CHUNKS,
  SUMMARY_MESSAGES,
  citingStatements,
  selectSummaryChunks,
  spreadOrder,
  validateSummaryOutput,
  type SummaryResponse,
} from "@/lib/summary";
import { sourcesKey } from "@/lib/summary-store";

import { mockModel, readStream, streamedText } from "../helpers/chat";
import { dbError, failingDatabase } from "../helpers/db-errors";
import { stubEmbed } from "../helpers/embeddings";
import { fileFrom, readFixture, uploadRequest } from "../helpers/fixtures";
import { createTestDatabase } from "../helpers/pglite";

/**
 * Zusammenfassung und Fragevorschläge von der Anfrage bis zum Cache.
 *
 * Echt: Quellenstand, Auswahl der Chunks, Cache-SQL und Rate-Limit gegen
 * PGlite, generateObject des AI SDK. Gestubbt: Embeddings beim Ingest und
 * das Modell (`MockLanguageModelV2.doGenerate`).
 */

let db: PGlite;
let vertragId: string;

const GOOD = {
  summary:
    "Der Mustermietvertrag regelt eine Wohnung und die Kaution [1]. Eine Notiz nennt eine Katze namens Mimi [2].",
  questions: [
    "Wie hoch ist die Kaution?",
    "Wann ist die Miete fällig?",
    "Wie heißt die Katze?",
  ],
};

function generating(output: unknown | (() => unknown)): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    modelId: "mock-summary",
    doGenerate: async () => ({
      content: [
        {
          type: "text",
          text:
            typeof output === "string"
              ? output
              : JSON.stringify(typeof output === "function" ? output() : output),
        },
      ],
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      warnings: [],
    }),
  });
}

function postRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/summary", { method: "POST", headers });
}

function depsWith(model: MockLanguageModelV2, overrides: Partial<SummaryDeps> = {}): SummaryDeps {
  return { db, model: () => model, ...overrides };
}

async function body(response: Response): Promise<SummaryResponse> {
  return (await response.json()) as SummaryResponse;
}

async function cacheRows(): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notebook_summaries");
  return rows[0]?.n ?? 0;
}

async function ingestText(content: string, name: string): Promise<string> {
  const response = await handleIngest(
    uploadRequest(fileFrom(content, name, "text/plain")),
    { db, embed: stubEmbed },
  );
  return ((await response.json()) as { id: string }).id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const bytes = await readFixture("muster-mietvertrag.pdf");
  const vertrag = await handleIngest(
    uploadRequest(fileFrom(bytes, "muster-mietvertrag.pdf", "application/pdf")),
    { db, embed: stubEmbed },
  );
  vertragId = ((await vertrag.json()) as { id: string }).id;
  await ingestText("Die Katze heißt Mimi.", "notiz.txt");
}, 30_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM notebook_summaries; DELETE FROM rate_limit_events;");
});

describe("GET und POST /api/summary: Cache pro Quellenstand", () => {
  it("meldet ohne Cache `stale`, ohne das Modell zu fragen", async () => {
    const model = generating(GOOD);
    const response = await handleGetSummary(depsWith(model));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "stale", summary: null });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("erzeugt per POST Text, Belege und drei Fragen und schreibt den Cache", async () => {
    const model = generating(GOOD);
    const response = await handlePostSummary(postRequest(), depsWith(model));
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    expect(result.summary.text).toBe(GOOD.summary);
    expect(result.summary.questions).toEqual(GOOD.questions);
    const [first] = result.summary.citations;
    expect(first).toMatchObject({ index: 1, documentId: vertragId });
    expect(first?.href).toMatch(new RegExp(`^/api/documents/${vertragId}/file(#page=\\d+)?$`));

    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    expect(call?.prompt[0]).toEqual({ role: "system", content: SUMMARY_SYSTEM_PROMPT });
    expect(call?.responseFormat).toMatchObject({ type: "json" });
    expect(call?.maxOutputTokens).toBe(500);
    expect(await cacheRows()).toBe(1);
  });

  it("liest beim zweiten GET und POST aus dem Cache, ohne Modell und ohne Rate-Limit", async () => {
    await handlePostSummary(postRequest(), depsWith(generating(GOOD)));
    const model = generating(GOOD);

    const get = await body(await handleGetSummary(depsWith(model)));
    expect(get.status).toBe("ready");
    for (let i = 0; i < SUMMARY_RATE_LIMIT.limit + 2; i++) {
      const post = await handlePostSummary(postRequest(), depsWith(model));
      expect(post.status).toBe(200);
    }
    expect(model.doGenerateCalls).toHaveLength(0);
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM rate_limit_events WHERE endpoint = 'summary'",
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("gilt nach einem Upload als veraltet und nach dem Löschen wieder als veraltet", async () => {
    await handlePostSummary(postRequest(), depsWith(generating(GOOD)));
    const model = generating(GOOD);
    expect((await body(await handleGetSummary(depsWith(model)))).status).toBe("ready");

    const extraId = await ingestText("Der Hund heißt Bello.", "hund.txt");
    expect((await body(await handleGetSummary(depsWith(model)))).status).toBe("stale");

    await handlePostSummary(postRequest(), depsWith(generating(GOOD)));
    expect((await body(await handleGetSummary(depsWith(model)))).status).toBe("ready");

    await handleDeleteDocument(db, extraId);
    expect((await body(await handleGetSummary(depsWith(model)))).status).toBe("stale");
  });

  it("cacht nicht, wenn sich die Quellen während des Modellaufrufs ändern", async () => {
    let extraId = "";
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        extraId = await ingestText("Neue Quelle während der Erzeugung.", "zwischendurch.txt");
        return {
          content: [{ type: "text", text: JSON.stringify(GOOD) }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    });
    const result = await body(await handlePostSummary(postRequest(), depsWith(model)));
    expect(result.status).toBe("ready");
    expect(await cacheRows()).toBe(0);
    await handleDeleteDocument(db, extraId);
  });

  it("hält bei zwei gleichzeitigen POSTs genau eine Zeile (Upsert)", async () => {
    const model = generating(GOOD);
    const responses = await Promise.all([
      handlePostSummary(postRequest(), depsWith(model)),
      handlePostSummary(postRequest(), depsWith(model)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await cacheRows()).toBe(1);
    // Ehrlich festgehalten: Ohne Sperre erzeugen beide (siehe Handler-Kommentar).
    expect(model.doGenerateCalls.length).toBeLessThanOrEqual(2);
  });

  it("speichert den Modellnamen", async () => {
    await handlePostSummary(postRequest(), depsWith(generating(GOOD)));
    const { rows } = await db.query<{ model: string }>("SELECT model FROM notebook_summaries");
    expect(rows).toEqual([{ model: "mock-summary" }]);
  });
});

describe("POST /api/summary: unbrauchbare Ausgabe", () => {
  it.each([
    ["kein JSON", "Hier ist die Zusammenfassung: …"],
    ["ohne Beleg", { summary: "Es geht um einen Mietvertrag.", questions: GOOD.questions }],
    ["erfundener Beleg", { summary: "Mietvertrag [9].", questions: GOOD.questions }],
    ["zwei statt drei Fragen", { summary: GOOD.summary, questions: GOOD.questions.slice(0, 2) }],
  ])("antwortet bei %s 200 mit summary: null und cacht nichts", async (_label, output) => {
    const response = await handlePostSummary(postRequest(), depsWith(generating(output)));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "unavailable", summary: null });
    expect(await cacheRows()).toBe(0);
  });
});

describe("POST /api/summary: Protokoll", () => {
  it("schreibt bei unbrauchbarer Ausgabe nur den Grund ins Log, nicht den Text aus den Quellen", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await handlePostSummary(
        postRequest(),
        depsWith(generating({ summary: "Geheime Kautionshöhe [9].", questions: GOOD.questions })),
      );
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain("Beleg außerhalb der Quellen");
      expect(logged).not.toContain("Geheime Kautionshöhe");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /api/summary: Grenzen und Fehler", () => {
  it("weist die 7. Erzeugung derselben IP in 15 Minuten mit 429 ab, ohne Modellaufruf", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < SUMMARY_RATE_LIMIT.limit; i++) {
      await db.exec("DELETE FROM notebook_summaries;");
      const ok = await handlePostSummary(postRequest(headers), depsWith(generating(GOOD)));
      expect(ok.status).toBe(200);
    }
    await db.exec("DELETE FROM notebook_summaries;");
    const model = generating(GOOD);
    const blocked = await handlePostSummary(postRequest(headers), depsWith(model));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(((await blocked.json()) as { error: string }).error).toMatch(
      /^Zu viele Zusammenfassungen in kurzer Zeit\./,
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("meldet einen fehlenden Key als 503 ohne Retry-Hinweis", async () => {
    const response = await handlePostSummary(postRequest(), {
      db,
      model: () => {
        throw new ConfigError("OPENAI_API_KEY ist nicht gesetzt.");
      },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: CONFIG_ERROR_MESSAGE });
  });

  it("meldet aufgebrauchtes Guthaben als 503 und einen Serverfehler von OpenAI als 502", async () => {
    const failing = (statusCode: number, responseBody: string) =>
      new MockLanguageModelV2({
        doGenerate: async () => {
          throw new APICallError({
            message: "upstream",
            url: "https://api.openai.com/v1/responses",
            requestBodyValues: {},
            statusCode,
            responseBody,
            isRetryable: false,
          });
        },
      });
    const quota = await handlePostSummary(
      postRequest(),
      depsWith(failing(429, '{"error":{"code":"insufficient_quota"}}')),
    );
    expect(quota.status).toBe(503);
    expect(await quota.json()).toEqual({ error: QUOTA_ERROR_MESSAGE });

    const upstream = await handlePostSummary(postRequest(), depsWith(failing(500, "Bad gateway")));
    expect(upstream.status).toBe(502);
    expect(await upstream.json()).toEqual({ error: SUMMARY_MESSAGES.upstreamFailed });
  });

  it("bricht nach dem Timeout mit 504 und eigener Meldung ab", async () => {
    const hanging = new MockLanguageModelV2({
      doGenerate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
        }),
    });
    const response = await handlePostSummary(postRequest(), depsWith(hanging, { timeoutMs: 50 }));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: SUMMARY_MESSAGES.timeout });
  });

  it("meldet ein falsches Datenbank-Passwort bei GET und POST als 503", async () => {
    const broken = failingDatabase(dbError("password authentication failed", "28P01"));
    const get = await handleGetSummary({ db: broken, model: () => generating(GOOD) });
    expect(get.status).toBe(503);
    const post = await handlePostSummary(postRequest(), { db: broken, model: () => generating(GOOD) });
    expect(post.status).toBe(503);
  });
});

describe("Notebook ohne Quellen", () => {
  it("antwortet `empty` und fragt kein Modell", async () => {
    const empty = await createTestDatabase();
    try {
      const model = generating(GOOD);
      const deps = { db: empty, model: () => model };
      expect(await body(await handleGetSummary(deps))).toEqual({ status: "empty", summary: null });
      expect(await body(await handlePostSummary(postRequest(), deps))).toEqual({
        status: "empty",
        summary: null,
      });
      expect(model.doGenerateCalls).toHaveLength(0);
    } finally {
      await empty.close();
    }
  }, 30_000);
});

describe("Migration nicht ausgeführt (Tabelle fehlt)", () => {
  it("meldet die Zusammenfassung als 503 Konfiguration, der Chat antwortet weiter", async () => {
    const old = await createTestDatabase();
    try {
      await old.exec("DROP TABLE notebook_summaries;");
      const response = await handleIngest(
        uploadRequest(fileFrom("Die Kaution beträgt drei Monatsmieten.", "kaution.txt", "text/plain")),
        { db: old, embed: stubEmbed },
      );
      const id = ((await response.json()) as { id: string }).id;

      const get = await handleGetSummary({ db: old, model: () => generating(GOOD) });
      expect(get.status).toBe(503);
      expect(await get.json()).toEqual({ error: CONFIG_ERROR_MESSAGE });
      const post = await handlePostSummary(postRequest(), { db: old, model: () => generating(GOOD) });
      expect(post.status).toBe(503);

      const chat = await handleChat(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: "Wie hoch ist die Kaution?", documentIds: [id] }),
        }),
        { db: old, embed: stubEmbed, model: () => mockModel() },
      );
      expect(chat.status).toBe(200);
      expect(streamedText(await readStream(chat))).toContain("Kaution");
    } finally {
      await old.close();
    }
  }, 30_000);
});

describe("Eingabe für das Modell", () => {
  it("bleibt im Tokenbudget und nutzt höchstens SUMMARY_MAX_CHUNKS Quellenblöcke", async () => {
    const model = generating(GOOD);
    await handlePostSummary(postRequest(), depsWith(model));
    const call = model.doGenerateCalls[0];
    const user = call?.prompt.find((message) => message.role === "user");
    const text = JSON.stringify(user?.content ?? "");
    const blocks = text.match(/<quelle nr=/g) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.length).toBeLessThanOrEqual(SUMMARY_MAX_CHUNKS);
    expect(text).not.toContain(SYSTEM_PROMPT.slice(0, 40));
  });
});

describe("spreadOrder", () => {
  it("beginnt am Anfang, springt in die Mitte und deckt alles genau einmal ab", () => {
    expect(spreadOrder(0)).toEqual([]);
    expect(spreadOrder(1)).toEqual([0]);
    expect(spreadOrder(8).slice(0, 4)).toEqual([0, 4, 2, 6]);
    for (const n of [3, 7, 10, 33]) {
      expect([...spreadOrder(n)].sort((a, b) => a - b)).toEqual([...Array(n).keys()]);
    }
  });
});

describe("selectSummaryChunks", () => {
  const doc = (id: string, count: number, tokens = 500) => ({
    documentId: id,
    chunks: Array.from({ length: count }, (_, i) => ({ chunkId: `${id}-${i}`, tokenCount: tokens })),
  });

  it("verteilt das Budget gleichmäßig auf die Dokumente und quer durch jedes Dokument", () => {
    const picked = selectSummaryChunks([doc("a", 20), doc("b", 20)]);
    expect(picked).toHaveLength(SUMMARY_INPUT_TOKENS / 500);
    expect(picked.filter((id) => id.startsWith("a-"))).toHaveLength(6);
    // Anfang und Mitte jedes Dokuments sind dabei, nicht nur die ersten Chunks.
    expect(picked).toEqual(expect.arrayContaining(["a-0", "a-10", "b-0", "b-10"]));
    // Reihenfolge: Dokument, dann Position.
    expect(picked.indexOf("a-10")).toBeLessThan(picked.indexOf("b-0"));
  });

  it("lässt eine große Quelle nicht das ganze Budget nehmen", () => {
    const picked = selectSummaryChunks([doc("gross", 200, 700), doc("klein", 1, 50)]);
    expect(picked).toContain("klein-0");
  });

  it("hält Höchstzahl und Budget ein und überspringt zu große Chunks", () => {
    expect(selectSummaryChunks([doc("viele", 100, 10)])).toHaveLength(SUMMARY_MAX_CHUNKS);
    const mixed = selectSummaryChunks(
      [{ documentId: "m", chunks: [{ chunkId: "m-0", tokenCount: 900 }, { chunkId: "m-1", tokenCount: 50 }] }],
      100,
    );
    expect(mixed).toEqual(["m-1"]);
    expect(selectSummaryChunks([])).toEqual([]);
  });
});

describe("validateSummaryOutput", () => {
  it("säubert Fragen von Belegen und Steuerzeichen", () => {
    const result = validateSummaryOutput(
      { summary: " Text [1]. ", questions: ["Wie hoch? [1]", "Wann\u0000 fällig?", "Wer zahlt?"] },
      2,
    );
    expect(result).toEqual({
      success: true,
      value: { summary: "Text [1].", questions: ["Wie hoch?", "Wann fällig?", "Wer zahlt?"] },
    });
  });

  it.each([
    ["kein Objekt", null],
    ["leerer Text", { summary: " ", questions: GOOD.questions }],
    ["Beleg [0]", { summary: "Text [0].", questions: GOOD.questions }],
    ["doppelte Frage", { summary: "Text [1].", questions: ["A?", "A?", "B?"] }],
    ["Frage kein String", { summary: "Text [1].", questions: ["A?", 2, "B?"] }],
    ["vier Fragen", { summary: "Text [1].", questions: ["A?", "B?", "C?", "D?"] }],
  ])("lehnt %s ab", (_label, value) => {
    expect(validateSummaryOutput(value, 2).success).toBe(false);
  });
});

describe("citingStatements", () => {
  it("liefert die Sätze, die einen Beleg zitieren, ohne die Marker", () => {
    const text = "Die Kaution beträgt drei Mieten [1]. Die Katze heißt Mimi [2]. Miete am Dritten [1][2].";
    expect(citingStatements(text, 1)).toBe("Die Kaution beträgt drei Mieten  . Miete am Dritten   .");
    expect(citingStatements(text, 3)).toBe("");
  });
});

describe("sourcesKey", () => {
  it("hängt nicht von der Reihenfolge ab, aber von jedem Hash", () => {
    expect(sourcesKey(["a", "b"])).toBe(sourcesKey(["b", "a"]));
    expect(sourcesKey(["a", "b"])).not.toBe(sourcesKey(["a"]));
    expect(sourcesKey(["a"])).toMatch(/^[0-9a-f]{64}$/);
  });
});
