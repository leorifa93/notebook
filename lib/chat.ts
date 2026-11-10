import type { UIMessage } from "ai";

import type { Citation } from "@/lib/prompt";
import type { RetrievedChunk } from "@/lib/retrieval";

/**
 * Gemeinsame Typen und Grenzen des Chats, für Route und Client.
 *
 * Diese Datei enthält nur Typen und Konstanten und darf in
 * Client-Komponenten landen (wie lib/limits.ts).
 */

/** Höchstlänge einer Frage in Zeichen. */
export const MAX_QUESTION_CHARS = 2000;

/**
 * Höchstzahl ausgewählter Quellen pro Frage. Ohne Grenze landete ein
 * beliebig langes ID-Array im `ANY($2::uuid[])`; 100 liegt weit über dem,
 * was ein Demo-Notebook hat.
 */
export const MAX_SELECTED_SOURCES = 100;

/** Wie viele Belege höchstens in den Prompt gehen (Eval misst Recall@5). */
export const CHAT_TOP_K = 5;

/** Belegte Kurzantworten; schneidet nichts Sinnvolles ab. */
export const CHAT_MAX_OUTPUT_TOKENS = 700;

/**
 * Abbruch nach 45 s, deutlich unter `maxDuration = 60`: So bekommt der
 * Nutzer unsere Meldung statt eines stillen Plattform-Timeouts.
 */
export const CHAT_TIMEOUT_MS = 45_000;

/**
 * Untergrenze der Kosinus-Ähnlichkeit für den besten Treffer. Darunter
 * antwortet der Chat ohne Modellaufruf mit der Absage (Stufe 1); darüber
 * entscheidet Regel 3 des Systemprompts (Stufe 2).
 *
 * Startwert, freigegeben von Leonardo am 10.11.2026. Kalibrierung an den
 * Fragen A1–A5 und D1–D3 aus docs/eval-plan.md in Schritt 4.
 */
export const MIN_SIMILARITY = 0.25;

/**
 * Stufe 1 der Absage. Der RRF-Score taugt dafür nicht: Er addiert nur
 * Ränge und hat immer einen „besten“ Treffer. Reine Volltexttreffer
 * (`vectorSimilarity = null`) zählen als 0, weil eine ODER-Suche schon über
 * ein Füllwort trifft. Maßgeblich ist der beste Vektorkandidat insgesamt,
 * auch wenn RRF ihn aus den Top-K gedrängt hat.
 */
export function shouldRefuse(chunks: readonly RetrievedChunk[]): boolean {
  const best = Math.max(
    0,
    ...chunks.map((chunk) => Math.max(chunk.bestVectorSimilarity ?? 0, chunk.vectorSimilarity ?? 0)),
  );
  return best < MIN_SIMILARITY;
}

/**
 * Data-Parts im Stream. `citations` kommt vor dem ersten Textstück, damit
 * die Belegkarten stehen, bevor die Antwort tippt, und `[n]` sofort
 * auflösbar ist.
 */
export type ChatDataParts = {
  citations: Citation[];
};

export type ChatUIMessage = UIMessage<never, ChatDataParts>;

/** Body von POST /api/chat. Bewusst nur die aktuelle Frage, kein Verlauf. */
export interface ChatRequest {
  question: string;
  documentIds: string[];
}

export const CHAT_MESSAGES = {
  invalidJson: "Body ist kein gültiges JSON.",
  emptyQuestion: "Feld 'question' fehlt oder ist leer.",
  questionTooLong: `Die Frage ist zu lang (maximal ${MAX_QUESTION_CHARS} Zeichen).`,
  noSources: "Wähle mindestens eine Quelle aus, damit Notebook antworten kann.",
  tooManySources: `Es können höchstens ${MAX_SELECTED_SOURCES} Quellen gleichzeitig ausgewählt sein.`,
  invalidSourceIds: "Die Quellenauswahl enthält eine ungültige ID. Bitte lade die Seite neu.",
  sourcesGone: "Die ausgewählten Quellen gibt es nicht mehr. Bitte lade die Seite neu.",
  searchFailed: "Die Quellen konnten gerade nicht durchsucht werden. Bitte versuche es erneut.",
  upstreamFailed:
    "Die Antwort konnte gerade nicht erzeugt werden. Bitte versuche es in einem Moment erneut.",
  timeout:
    "Die Antwort hat zu lange gedauert. Bitte stelle die Frage enger oder wähle weniger Quellen.",
  aborted: "Die Antwort ist abgebrochen. Bitte stelle die Frage erneut.",
} as const;
