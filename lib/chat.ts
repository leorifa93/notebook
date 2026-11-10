import type { UIMessage } from "ai";

import type { Citation } from "@/lib/prompt";

/**
 * Gemeinsame Typen und Grenzen des Chats, für Route und Client.
 *
 * Diese Datei enthält nur Typen und Konstanten und darf in
 * Client-Komponenten landen (wie lib/limits.ts).
 */

/** Höchstlänge einer Frage in Zeichen. */
export const MAX_QUESTION_CHARS = 2000;

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
  invalidSourceIds: "Die Quellenauswahl enthält eine ungültige ID. Bitte lade die Seite neu.",
  sourcesGone: "Die ausgewählten Quellen gibt es nicht mehr. Bitte lade die Seite neu.",
  searchFailed: "Die Quellen konnten gerade nicht durchsucht werden. Bitte versuche es erneut.",
  upstreamFailed:
    "Die Antwort konnte gerade nicht erzeugt werden. Bitte versuche es in einem Moment erneut.",
  timeout:
    "Die Antwort hat zu lange gedauert. Bitte stelle die Frage enger oder wähle weniger Quellen.",
  aborted: "Die Antwort ist abgebrochen. Bitte stelle die Frage erneut.",
} as const;
