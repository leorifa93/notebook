import { MockLanguageModelV2 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { handleIngest } from "@/app/api/ingest/handler";
import { handleGetSummary, handlePostSummary, type SummaryDeps } from "@/app/api/summary/handler";
import { ConfigError } from "@/lib/env";
import { CONFIG_ERROR_MESSAGE } from "@/lib/errors";
import { OVERVIEW_MESSAGES, loadOverview, type OverviewState } from "@/lib/summary-client";

import { stubEmbed } from "../helpers/embeddings";
import { fileFrom, uploadRequest } from "../helpers/fixtures";
import { createTestDatabase } from "../helpers/pglite";

/**
 * Ablauf im Browser gegen die echten Handler, ohne Netz und ohne DOM:
 * `fetch` leitet auf GET bzw. POST /api/summary mit PGlite und
 * `MockLanguageModelV2` um.
 */

let db: PGlite;

const GOOD = JSON.stringify({
  summary: "Die Kaution beträgt drei Monatsmieten [1].",
  questions: ["Wie hoch ist die Kaution?", "Wann ist sie fällig?", "Wer verwahrt sie?"],
});

function model(text = GOOD): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  });
}

function routedFetch(deps: SummaryDeps, log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    log.push(`${method} ${String(input)}`);
    const request = new Request(`http://localhost${String(input)}`, init);
    return method === "POST" ? handlePostSummary(request, deps) : handleGetSummary(deps);
  }) as typeof fetch;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await handleIngest(
    uploadRequest(fileFrom("Die Kaution beträgt drei Monatsmieten.", "kaution.txt", "text/plain")),
    { db, embed: stubEmbed },
  );
}, 30_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM notebook_summaries; DELETE FROM rate_limit_events;");
});

describe("loadOverview", () => {
  it("fragt erst den Cache, erzeugt bei `stale` einmal und liest danach nur noch", async () => {
    const mock = model();
    const log: string[] = [];
    const progress: OverviewState[] = [];
    const first = await loadOverview(routedFetch({ db, model: () => mock }, log), {
      onProgress: (state) => progress.push(state),
    });
    expect(first.status).toBe("ready");
    expect(log).toEqual(["GET /api/summary", "POST /api/summary"]);
    expect(progress).toEqual([{ status: "loading", phase: "generating" }]);

    log.length = 0;
    const second = await loadOverview(routedFetch({ db, model: () => mock }, log));
    expect(second.status).toBe("ready");
    expect(log).toEqual(["GET /api/summary"]);
    expect(mock.doGenerateCalls).toHaveLength(1);
  });

  it("meldet unbrauchbare Ausgabe als `unavailable`, nicht als Fehler", async () => {
    const state = await loadOverview(routedFetch({ db, model: () => model("kein JSON") }));
    expect(state).toEqual({ status: "unavailable" });
  });

  it("zeigt die 503-Meldung des Servers und bietet keinen erneuten Versuch an", async () => {
    const state = await loadOverview(
      routedFetch({
        db,
        model: () => {
          throw new ConfigError("OPENAI_API_KEY fehlt");
        },
      }),
    );
    expect(state).toEqual({ status: "error", message: CONFIG_ERROR_MESSAGE, retryable: false });
  });

  it("ersetzt eine HTML-Fehlerseite und Netzfehler durch eigene Meldungen", async () => {
    const html = (async () =>
      new Response("<html>504</html>", { status: 504 })) as unknown as typeof fetch;
    expect(await loadOverview(html)).toEqual({
      status: "error",
      message: OVERVIEW_MESSAGES.unknown,
      retryable: true,
    });
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await loadOverview(offline)).toEqual({
      status: "error",
      message: OVERVIEW_MESSAGES.offline,
      retryable: true,
    });
  });

  it("wirft bei Abbruch, statt einen Fehlerzustand zu melden", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborting = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(loadOverview(aborting, { signal: controller.signal })).rejects.toThrow();
  });
});
