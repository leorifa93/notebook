import { NextResponse } from "next/server";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type LanguageModel,
} from "ai";

import {
  CHAT_MAX_OUTPUT_TOKENS,
  CHAT_MESSAGES,
  CHAT_TIMEOUT_MS,
  CHAT_TOP_K,
  MAX_QUESTION_CHARS,
  shouldRefuse,
  type ChatRequest,
  type ChatUIMessage,
} from "@/lib/chat";
import type { Queryable } from "@/lib/db";
import { existingDocumentIds, isUuid } from "@/lib/documents";
import {
  classifyUpstreamError,
  isUpstreamApiError,
  permanentErrorMessage,
} from "@/lib/errors";
import { DEFAULT_NOTEBOOK_ID } from "@/lib/notebooks";
import { stripControlChars } from "@/lib/pdf";
import { REFUSAL_TEXT, SYSTEM_PROMPT, buildCitations, buildUserPrompt } from "@/lib/prompt";
import { retrieveAndRerank, type RetrievedChunk } from "@/lib/retrieval";

/**
 * Logik hinter POST /api/chat, mit austauschbaren Abhängigkeiten.
 *
 * Getrennt von route.ts wie beim Ingest: Die Tests rufen diese Funktion mit
 * PGlite, Stub-Embeddings und `MockLanguageModelV2` auf, die Route mit
 * Supabase und OpenAI.
 *
 *   1. Body prüfen       → Frage bereinigen, Quellen-IDs prüfen
 *   2. Auswahl schneiden → nur Dokumente des Notebooks
 *   3. Suchen            → retrieveAndRerank() (Hybrid + RRF)
 *   4. Absage prüfen     → kein passender Treffer: Absage ohne Modellaufruf
 *   5. Streamen          → Belegliste als `data-citations`, dann der Text
 *
 * Fehler bis Schritt 3 kommen als JSON mit Status; danach läuft der Stream,
 * und Fehler kommen als `error`-Chunk mit deutscher Meldung.
 */

export interface ChatDeps {
  db: Queryable;
  embed: (texts: readonly string[]) => Promise<number[][]>;
  /** Lazy, weil `openAiApiKey()` bei fehlendem Key wirft (→ 503, nicht 500). */
  model: () => LanguageModel;
  /** Nur für Tests kürzer; Standard `CHAT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

type Parsed = { ok: true; value: ChatRequest } | { ok: false; response: NextResponse };

function badRequest(error: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error }, { status: 400 }) };
}

/**
 * Prüft den Body. Die Frage wird von Steuerzeichen befreit, bevor sie in
 * Embedding und `plainto_tsquery` geht: Ein NUL-Byte ließe Postgres mit
 * `invalid byte sequence for encoding "UTF8": 0x00` abbrechen — dieselbe
 * Falle wie Live-Befund L1, diesmal über das Eingabefeld.
 */
export function parseChatRequest(body: unknown): Parsed {
  if (typeof body !== "object" || body === null) return badRequest(CHAT_MESSAGES.invalidJson);
  const { question: rawQuestion, documentIds: rawIds } = body as Record<string, unknown>;

  const question =
    typeof rawQuestion === "string" ? stripControlChars(rawQuestion).trim() : "";
  if (question.length === 0) return badRequest(CHAT_MESSAGES.emptyQuestion);
  if (question.length > MAX_QUESTION_CHARS) return badRequest(CHAT_MESSAGES.questionTooLong);

  // Fehlende oder leere Auswahl ist ein Nutzerfehler mit klarer Meldung,
  // nicht „alle Quellen“.
  if (rawIds === undefined || (Array.isArray(rawIds) && rawIds.length === 0)) {
    return badRequest(CHAT_MESSAGES.noSources);
  }
  if (
    !Array.isArray(rawIds) ||
    !rawIds.every((id): id is string => typeof id === "string" && isUuid(id))
  ) {
    // Ohne diese Prüfung landete "abc" im Cast `$3::uuid[]` und ergab 500.
    return badRequest(CHAT_MESSAGES.invalidSourceIds);
  }

  return { ok: true, value: { question, documentIds: [...new Set(rawIds)] } };
}

function errorResponse(context: string, error: unknown): NextResponse {
  const kind = classifyUpstreamError(error);
  console.error(`[chat] ${context} failed`, {
    kind,
    error: error instanceof Error ? error.message : String(error),
  });
  const permanent = permanentErrorMessage(kind);
  if (permanent) return NextResponse.json({ error: permanent }, { status: 503 });
  if (isUpstreamApiError(error)) {
    return NextResponse.json({ error: CHAT_MESSAGES.upstreamFailed }, { status: 502 });
  }
  return NextResponse.json({ error: CHAT_MESSAGES.searchFailed }, { status: 500 });
}

/** Meldung für einen Fehler, der erst während des Streams auftritt. */
function streamErrorMessage(error: unknown): string {
  const permanent = permanentErrorMessage(classifyUpstreamError(error));
  if (permanent) return permanent;
  if (isUpstreamApiError(error)) return CHAT_MESSAGES.upstreamFailed;
  return CHAT_MESSAGES.aborted;
}

/**
 * Absage im selben Stream-Format wie eine Antwort, damit der Client keinen
 * Sonderfall braucht: leere Belegliste, dann der Absagetext.
 */
function refusalResponse(): Response {
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: "start" });
      writer.write({ type: "data-citations", data: [] });
      writer.write({ type: "text-start", id: "refusal" });
      writer.write({ type: "text-delta", id: "refusal", delta: REFUSAL_TEXT });
      writer.write({ type: "text-end", id: "refusal" });
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

export async function handleChat(request: Request, deps: ChatDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: CHAT_MESSAGES.invalidJson }, { status: 400 });
  }

  const parsed = parseChatRequest(body);
  if (!parsed.ok) return parsed.response;
  const { question } = parsed.value;

  let chunks: RetrievedChunk[];
  let model: LanguageModel;
  try {
    const documentIds = await existingDocumentIds(
      deps.db,
      DEFAULT_NOTEBOOK_ID,
      parsed.value.documentIds,
    );
    if (documentIds.length === 0) {
      return NextResponse.json({ error: CHAT_MESSAGES.sourcesGone }, { status: 400 });
    }
    chunks = await retrieveAndRerank(question, documentIds, deps, { limit: CHAT_TOP_K });
    if (shouldRefuse(chunks)) return refusalResponse();
    model = deps.model();
  } catch (error) {
    // Konfiguration (503), OpenAI (502) oder Datenbank (500), siehe errorResponse.
    return errorResponse("prepare", error);
  }

  const citations = buildCitations(chunks);
  const timeoutMs = deps.timeoutMs ?? CHAT_TIMEOUT_MS;

  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      writer.write({ type: "data-citations", data: citations });

      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      try {
        const result = streamText({
          model,
          system: SYSTEM_PROMPT,
          prompt: buildUserPrompt(question, chunks),
          // Belegpflichtige Antwort: kein Grund für Kreativität.
          temperature: 0.1,
          maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
          maxRetries: 1,
          abortSignal: AbortSignal.any([request.signal, timeout.signal]),
          onError: ({ error }) => {
            console.error("[chat] stream failed", {
              kind: classifyUpstreamError(error),
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });

        for await (const chunk of result.toUIMessageStream<ChatUIMessage>({
          sendStart: false,
          sendFinish: false,
          onError: streamErrorMessage,
        })) {
          writer.write(chunk);
        }
      } finally {
        clearTimeout(timer);
      }

      // Ein Abbruch durch den Timeout endet im SDK still (kein Fehler-Chunk).
      // Der Nutzer soll wissen, warum die Antwort aufhört.
      if (timeout.signal.aborted && !request.signal.aborted) {
        console.error("[chat] timeout", { timeoutMs });
        writer.write({ type: "error", errorText: CHAT_MESSAGES.timeout });
      }
      writer.write({ type: "finish" });
    },
    onError: streamErrorMessage,
  });

  return createUIMessageStreamResponse({ stream });
}
