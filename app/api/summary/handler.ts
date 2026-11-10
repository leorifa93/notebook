import { NextResponse } from "next/server";
import {
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
  generateObject,
  jsonSchema,
  type JSONSchema7,
  type LanguageModel,
} from "ai";

import type { Queryable } from "@/lib/db";
import {
  classifyUpstreamError,
  isUpstreamApiError,
  permanentErrorMessage,
} from "@/lib/errors";
import { DEFAULT_NOTEBOOK_ID } from "@/lib/notebooks";
import { SUMMARY_SYSTEM_PROMPT, buildCitations, buildSummaryPrompt } from "@/lib/prompt";
import { SUMMARY_RATE_LIMIT, clientIp, consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";
import {
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_MESSAGES,
  SUMMARY_QUESTION_COUNT,
  SUMMARY_TIMEOUT_MS,
  citingStatements,
  selectSummaryChunks,
  validateSummaryOutput,
  type SummaryOutput,
  type SummaryResponse,
} from "@/lib/summary";
import {
  getCachedSummary,
  loadChunksByIds,
  loadSourcesKey,
  loadSummaryChunkRefs,
  saveSummary,
  type CachedSummary,
} from "@/lib/summary-store";

/**
 * Logik hinter GET und POST /api/summary (Entscheidung 6 in
 * docs/schritt-3-plan.md), mit austauschbaren Abhängigkeiten wie beim Chat.
 *
 * GET liest nur: Passt der Cache zum Quellenstand, kommt er; sonst `stale`.
 * POST erzeugt bei Bedarf:
 *
 *   1. Quellenstand    → keine Quellen: `empty`, keine Modellanfrage
 *   2. Cache           → passt schon (zweiter Tab, zweiter Klick): kein Aufruf
 *   3. Rate-Limit      → 6 / 15 min / IP, nur bei Cache-Miss
 *   4. Eingabe         → gleichmäßig verteilte Chunks, ≤ ~6.000 Tokens
 *   5. Modell          → generateObject mit JSON-Schema, eigene Prüfung
 *   6. Speichern       → nur, wenn der Quellenstand noch derselbe ist
 *
 * Nebenläufige POSTs ohne Cache erzeugen beide (zwei Tabs gleichzeitig).
 * Eine Sperre über die Dauer des Modellaufrufs hieße eine offene Transaktion
 * am Pooler für mehrere Sekunden; das Upsert sorgt stattdessen dafür, dass
 * genau eine gültige Zeile bleibt. Der zweite Aufruf kostet ~0,001 $, und
 * das Rate-Limit deckelt ihn.
 */

export interface SummaryDeps {
  db: Queryable;
  /** Lazy, weil `openAiApiKey()` bei fehlendem Key wirft (→ 503, nicht 500). */
  model: () => LanguageModel;
  /** Nur für Tests kürzer; Standard `SUMMARY_TIMEOUT_MS`. */
  timeoutMs?: number;
}

const SUMMARY_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Drei bis fünf Sätze, jede Aussage mit Beleg [n].",
    },
    questions: {
      type: "array",
      items: { type: "string" },
      minItems: SUMMARY_QUESTION_COUNT,
      maxItems: SUMMARY_QUESTION_COUNT,
      description: "Genau drei Fragen, die sich mit den Quellen beantworten lassen.",
    },
  },
  required: ["summary", "questions"],
  additionalProperties: false,
};

function json(body: SummaryResponse): NextResponse {
  return NextResponse.json(body);
}

function ready(cached: CachedSummary): NextResponse {
  const { sourcesKey: _key, ...summary } = cached;
  return json({ status: "ready", summary });
}

function errorResponse(context: string, error: unknown): NextResponse {
  const kind = classifyUpstreamError(error);
  console.error(`[summary] ${context} failed`, {
    kind,
    error: error instanceof Error ? error.message : String(error),
  });
  // Fehlt notebook_summaries (Migration nicht ausgeführt, 42P01), landet das
  // hier als Konfiguration: 503 ohne Retry-Hinweis. Der Chat liest die
  // Tabelle nicht und bleibt nutzbar.
  const permanent = permanentErrorMessage(kind);
  if (permanent) return NextResponse.json({ error: permanent }, { status: 503 });
  if (isUpstreamApiError(error)) {
    return NextResponse.json({ error: SUMMARY_MESSAGES.upstreamFailed }, { status: 502 });
  }
  return NextResponse.json({ error: SUMMARY_MESSAGES.failed }, { status: 500 });
}

/**
 * Grund aus `NoObjectGeneratedError`: bei einer Ablehnung durch
 * `validateSummaryOutput` deren kurze Begründung, sonst die erste Zeile.
 * Die vollständigen Meldungen des SDK zitieren die Ausgabe wörtlich.
 */
function unusableReason(error: NoObjectGeneratedError): string {
  const cause = error.cause;
  if (TypeValidationError.isInstance(cause) && cause.cause instanceof Error) {
    return cause.cause.message;
  }
  if (JSONParseError.isInstance(cause)) return "kein gültiges JSON";
  return error.message.split("\n")[0]?.slice(0, 120) ?? "unbekannt";
}

function modelName(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

export async function handleGetSummary(deps: SummaryDeps): Promise<NextResponse> {
  try {
    const key = await loadSourcesKey(deps.db, DEFAULT_NOTEBOOK_ID);
    if (key === null) return json({ status: "empty", summary: null });
    const cached = await getCachedSummary(deps.db, DEFAULT_NOTEBOOK_ID);
    if (cached?.sourcesKey === key) return ready(cached);
    return json({ status: "stale", summary: null });
  } catch (error) {
    return errorResponse("load", error);
  }
}

export async function handlePostSummary(
  request: Request,
  deps: SummaryDeps,
): Promise<NextResponse> {
  let key: string;
  let chunks: Awaited<ReturnType<typeof loadChunksByIds>>;
  let model: LanguageModel;
  try {
    const current = await loadSourcesKey(deps.db, DEFAULT_NOTEBOOK_ID);
    if (current === null) return json({ status: "empty", summary: null });
    key = current;

    const cached = await getCachedSummary(deps.db, DEFAULT_NOTEBOOK_ID);
    if (cached?.sourcesKey === key) return ready(cached);

    const rate = await consumeRateLimit(deps.db, clientIp(request), SUMMARY_RATE_LIMIT);
    if (!rate.allowed) return tooManyRequests("Zusammenfassungen", rate.retryAfterSeconds);

    const refs = await loadSummaryChunkRefs(deps.db, DEFAULT_NOTEBOOK_ID);
    chunks = await loadChunksByIds(deps.db, DEFAULT_NOTEBOOK_ID, selectSummaryChunks(refs));
    if (chunks.length === 0) {
      // Quellen ohne Chunks speichert der Ingest nicht; bleibt nur ein
      // Löschen zwischen den Abfragen. Kein Modellaufruf ohne Text.
      return json({ status: "unavailable", summary: null });
    }
    model = deps.model();
  } catch (error) {
    return errorResponse("prepare", error);
  }

  const sourceCount = chunks.length;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), deps.timeoutMs ?? SUMMARY_TIMEOUT_MS);
  let output: SummaryOutput;
  try {
    const result = await generateObject({
      model,
      schema: jsonSchema<SummaryOutput>(SUMMARY_SCHEMA, {
        validate: (value) => validateSummaryOutput(value, sourceCount),
      }),
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: buildSummaryPrompt(chunks),
      temperature: 0.2,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      maxRetries: 1,
      abortSignal: AbortSignal.any([request.signal, timeout.signal]),
    });
    output = result.object;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      // Plan, Fehlerfälle: unbrauchbares JSON ist 200 mit `summary: null`.
      // Nicht gecacht, damit der nächste Quellenstand es neu versucht.
      // Nur der Grund, nicht der Text: Der enthält Inhalte der Quellen, und
      // die gehören nicht in die Vercel-Logs.
      console.error("[summary] unusable output", { reason: unusableReason(error) });
      return json({ status: "unavailable", summary: null });
    }
    if (timeout.signal.aborted && !request.signal.aborted) {
      console.error("[summary] timeout", { timeoutMs: deps.timeoutMs ?? SUMMARY_TIMEOUT_MS });
      return NextResponse.json({ error: SUMMARY_MESSAGES.timeout }, { status: 504 });
    }
    return errorResponse("generate", error);
  } finally {
    clearTimeout(timer);
  }

  const view = {
    text: output.summary,
    citations: buildCitations(chunks, (index) => citingStatements(output.summary, index)),
    questions: output.questions,
  };

  try {
    // Kam während des Aufrufs ein Upload oder ein Löschen dazu, gehört der
    // Text zum alten Stand. Zurückgeben ja, cachen nein: Sonst überschriebe
    // ein langsamer Aufruf den Cache eines schnelleren, neueren.
    if ((await loadSourcesKey(deps.db, DEFAULT_NOTEBOOK_ID)) === key) {
      await saveSummary(deps.db, DEFAULT_NOTEBOOK_ID, key, view, modelName(model));
    }
  } catch (error) {
    // Der Text ist bezahlt und gültig; er kommt trotzdem an. Ohne Cache
    // erzeugt der nächste Besuch neu, deshalb laut protokollieren.
    console.error("[summary] save failed", {
      kind: classifyUpstreamError(error),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return json({
    status: "ready",
    summary: { ...view, createdAt: new Date().toISOString() },
  });
}
