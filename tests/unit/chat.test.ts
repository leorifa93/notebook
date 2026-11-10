import { APICallError } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { handleChat, type ChatDeps } from "@/app/api/chat/handler";
import { handleIngest } from "@/app/api/ingest/handler";
import type { Citation } from "@/lib/prompt";
import { ConfigError } from "@/lib/env";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { retrieve } from "@/lib/retrieval";

import { hangingModel, mockModel, readStream, streamedText, textParts } from "../helpers/chat";
import { stubEmbed } from "../helpers/embeddings";
import { fileFrom, readFixture, uploadRequest } from "../helpers/fixtures";
import { createTestDatabase } from "../helpers/pglite";

/**
 * Chat von der Anfrage bis zum Stream.
 *
 * Echt: Validierung, Auswahl, Hybrid-SQL gegen PGlite, Prompt, Stream-Format
 * des AI SDK. Gestubbt: Embeddings (Bag of Words) und das Modell
 * (`MockLanguageModelV2` aus `ai/test`).
 */

let db: PGlite;
let vertragId: string;
let notizId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const ingestDeps = { db, embed: stubEmbed };
  const bytes = await readFixture("muster-mietvertrag.pdf");
  const vertrag = await handleIngest(
    uploadRequest(fileFrom(bytes, "muster-mietvertrag.pdf", "application/pdf")),
    ingestDeps,
  );
  vertragId = ((await vertrag.json()) as { id: string }).id;
  const notiz = await handleIngest(
    uploadRequest(fileFrom("Die Katze heißt Mimi.", "notiz.txt", "text/plain")),
    ingestDeps,
  );
  notizId = ((await notiz.json()) as { id: string }).id;
}, 30_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM rate_limit_events;");
});

function chatRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function depsWith(overrides: Partial<ChatDeps> = {}): ChatDeps {
  const model = mockModel();
  return { db, embed: stubEmbed, model: () => model, ...overrides };
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

const KAUTION = "Wie hoch ist die Kaution insgesamt?";

describe("POST /api/chat: Antwort", () => {
  it("schickt die Belegliste vor dem ersten Textstück", async () => {
    const response = await handleChat(
      chatRequest({ question: KAUTION, documentIds: [vertragId] }),
      depsWith(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const chunks = await readStream(response);
    const types = chunks.map((chunk) => chunk.type);
    const citationsAt = types.indexOf("data-citations");
    const firstTextAt = types.indexOf("text-delta");
    expect(citationsAt).toBeGreaterThanOrEqual(0);
    expect(firstTextAt).toBeGreaterThan(citationsAt);
    expect(types.at(-1)).toBe("finish");
    expect(streamedText(chunks)).toBe("Die Kaution beträgt 3.450 Euro [1].");
  });

  it("liefert Belege mit Titel, Seite, Ausschnitt und Link auf die Seite", async () => {
    const chunks = await readStream(
      await handleChat(chatRequest({ question: KAUTION, documentIds: [vertragId] }), depsWith()),
    );
    const citations = chunks.find((chunk) => chunk.type === "data-citations")?.data as Citation[];
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.length).toBeLessThanOrEqual(5);
    const [first] = citations;
    expect(first).toMatchObject({
      index: 1,
      documentId: vertragId,
      documentTitle: "muster-mietvertrag",
      page: 2,
      href: `/api/documents/${vertragId}/file#page=2`,
    });
    expect(first?.snippet).toContain("Miete");
    expect(first?.snippet.length).toBeLessThanOrEqual(250);
  });

  it("gibt dem Modell Systemprompt und genau die Belege als Quellenblöcke", async () => {
    const model = mockModel();
    const chunks = await readStream(
      await handleChat(
        chatRequest({ question: KAUTION, documentIds: [vertragId, notizId] }),
        depsWith({ model: () => model }),
      ),
    );
    const citations = chunks.find((chunk) => chunk.type === "data-citations")?.data as Citation[];

    expect(model.doStreamCalls).toHaveLength(1);
    const call = model.doStreamCalls[0];
    expect(call?.temperature).toBe(0.1);
    expect(call?.maxOutputTokens).toBe(700);
    const [system, user] = call?.prompt ?? [];
    expect(system).toEqual({ role: "system", content: SYSTEM_PROMPT });
    const userText = JSON.stringify(user);
    expect(userText.match(/<quelle nr=/g)).toHaveLength(citations.length);
    expect(userText).toContain(KAUTION);
  });

  it("zitiert nie eine abgewählte Quelle", async () => {
    const chunks = await readStream(
      await handleChat(chatRequest({ question: "Wie heißt die Katze?", documentIds: [notizId] }), depsWith()),
    );
    const citations = chunks.find((chunk) => chunk.type === "data-citations")?.data as Citation[];
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.every((citation) => citation.documentId === notizId)).toBe(true);
  });
});

describe("POST /api/chat: Ablehnungen vor jedem teuren Schritt", () => {
  it("lehnt leere Auswahl ab, ohne einzubetten oder das Modell zu fragen", async () => {
    const embed = vi.fn(stubEmbed);
    const model = mockModel();
    const response = await handleChat(
      chatRequest({ question: KAUTION, documentIds: [] }),
      depsWith({ embed, model: () => model }),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe(
      "Wähle mindestens eine Quelle aus, damit Notebook antworten kann.",
    );
    expect(embed).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("lehnt eine ID, die keine UUID ist, mit 400 statt 500 ab", async () => {
    const response = await handleChat(
      chatRequest({ question: KAUTION, documentIds: [vertragId, "abc"] }),
      depsWith(),
    );
    expect(response.status).toBe(400);
  });

  it("meldet gelöschte oder fremde Quellen, statt die Suche zu erweitern", async () => {
    const response = await handleChat(
      chatRequest({ question: KAUTION, documentIds: ["00000000-0000-4000-8000-0000000000ff"] }),
      depsWith(),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain("gibt es nicht mehr");
  });
});

describe("POST /api/chat: unsaubere Eingaben (Lehre aus L1)", () => {
  const dirty = "Wie hoch ist die\u0000 Kau\u0007tion\u001F insgesamt?";

  it("Gegenprobe: ein NUL-Byte in der Frage bricht die Suche in Postgres ab", async () => {
    await expect(retrieve(dirty, [vertragId], { db, embed: stubEmbed })).rejects.toThrow(/0x00/);
  });

  it("bereinigt die Frage, bevor sie Embedding und Datenbank erreicht", async () => {
    const embed = vi.fn(stubEmbed);
    const response = await handleChat(
      chatRequest({ question: dirty, documentIds: [vertragId] }),
      depsWith({ embed }),
    );
    expect(response.status).toBe(200);
    expect(embed).toHaveBeenCalledWith(["Wie hoch ist die Kaution insgesamt?"]);
    const chunks = await readStream(response);
    const citations = chunks.find((chunk) => chunk.type === "data-citations")?.data as Citation[];
    expect(citations[0]?.page).toBe(2);
  });

  it("behandelt eine Frage nur aus Steuerzeichen als leer", async () => {
    const response = await handleChat(
      chatRequest({ question: "\u0000\u0001 ", documentIds: [vertragId] }),
      depsWith(),
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/chat: Fehler", () => {
  it("meldet einen fehlenden Key als 503 ohne Retry-Hinweis", async () => {
    const response = await handleChat(
      chatRequest({ question: KAUTION, documentIds: [vertragId] }),
      depsWith({
        model: () => {
          throw new ConfigError("OPENAI_API_KEY ist nicht gesetzt.");
        },
      }),
    );
    expect(response.status).toBe(503);
    const error = await errorOf(response);
    expect(error).toContain("hilft nicht");
    expect(error).not.toMatch(/versuche es/i);
  });

  it("meldet einen abgelehnten Key beim Embedding als 503", async () => {
    const response = await handleChat(
      chatRequest({ question: KAUTION, documentIds: [vertragId] }),
      depsWith({
        embed: async () => {
          throw new APICallError({
            message: "Incorrect API key",
            url: "https://api.openai.com/v1/embeddings",
            requestBodyValues: {},
            statusCode: 401,
          });
        },
      }),
    );
    expect(response.status).toBe(503);
  });

  it("meldet einen Serverfehler von OpenAI als 502 mit Retry-Hinweis", async () => {
    const response = await handleChat(
      chatRequest({ question: KAUTION, documentIds: [vertragId] }),
      depsWith({
        embed: async () => {
          throw new APICallError({
            message: "Bad gateway",
            url: "https://api.openai.com/v1/embeddings",
            requestBodyValues: {},
            statusCode: 502,
            isRetryable: false,
          });
        },
      }),
    );
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toContain("in einem Moment erneut");
  });

  it("meldet einen Datenbankfehler als 500 ohne interne Details", async () => {
    const response = await handleChat(
      chatRequest({ question: KAUTION, documentIds: [vertragId] }),
      depsWith({
        db: {
          query: async () => {
            throw new Error('relation "documents" does not exist');
          },
        },
      }),
    );
    expect(response.status).toBe(500);
    const error = await errorOf(response);
    expect(error).toBe("Die Quellen konnten gerade nicht durchsucht werden. Bitte versuche es erneut.");
  });

  it("schickt einen Fehler mitten im Stream als deutsche Meldung ohne Stacktrace", async () => {
    const parts = textParts("Die Kaution");
    parts.splice(2, 0, { type: "error", error: new Error("socket hang up at foo (bar.js:1:1)") });
    const model = mockModel(parts);
    const chunks = await readStream(
      await handleChat(
        chatRequest({ question: KAUTION, documentIds: [vertragId] }),
        depsWith({ model: () => model }),
      ),
    );
    const error = chunks.find((chunk) => chunk.type === "error");
    expect(error?.errorText).toBe("Die Antwort ist abgebrochen. Bitte stelle die Frage erneut.");
  });

  it("bricht nach dem Timeout ab und sagt warum", async () => {
    const model = hangingModel();
    const chunks = await readStream(
      await handleChat(
        chatRequest({ question: KAUTION, documentIds: [vertragId] }),
        depsWith({ model: () => model, timeoutMs: 50 }),
      ),
    );
    const error = chunks.find((chunk) => chunk.type === "error");
    expect(error?.errorText).toContain("zu lange gedauert");
    expect(chunks.at(-1)?.type).toBe("finish");
  });
});
