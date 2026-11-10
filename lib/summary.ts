import type { Citation } from "@/lib/prompt";
import { stripControlChars } from "@/lib/text";

/**
 * Zusammenfassung und Fragevorschläge: Typen, Grenzen und reine Funktionen.
 *
 * Ohne Server-Abhängigkeiten, damit der Client Typen und Meldungen aus
 * derselben Datei liest wie die Route (wie lib/chat.ts). SQL und SHA-256
 * stehen in lib/summary-store.ts.
 */

/** Höchstens so viele geschätzte Tokens Quelltext gehen ins Modell (Plan: ~6.000). */
export const SUMMARY_INPUT_TOKENS = 6000;

/**
 * Höchstzahl der Chunks im Prompt. Bei vielen kleinen Chunks bliebe das
 * Tokenbudget eingehalten, die Belegnummern liefen aber bis [40]; zwölf
 * reichen für einen Überblick und halten die Belegliste lesbar.
 */
export const SUMMARY_MAX_CHUNKS = 12;

/** Drei bis fünf Sätze plus drei Fragen; schneidet nichts Sinnvolles ab. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 500;

/** Wie im Chat: deutlich unter `maxDuration = 60`, damit unsere Meldung ankommt. */
export const SUMMARY_TIMEOUT_MS = 45_000;

export const SUMMARY_QUESTION_COUNT = 3;

/** Ein Vorschlag wird als Frage gesendet; länger als ein Satz ist er nie. */
export const MAX_SUGGESTION_CHARS = 300;

/** Obergrenze für den Text, falls das Modell die Satzregel ignoriert. */
export const MAX_SUMMARY_CHARS = 2000;

export interface SummaryView {
  /** Text mit Belegen `[n]`; `n` zeigt in `citations`. */
  text: string;
  citations: Citation[];
  questions: string[];
  /** ISO-8601. */
  createdAt: string;
}

/**
 * Antwort von GET und POST /api/summary.
 *
 * - `empty`: keine Quellen, also auch keine Modellanfrage.
 * - `stale`: kein Cache für den aktuellen Quellenstand; der Client stößt POST an.
 * - `ready`: Zusammenfassung zum aktuellen Quellenstand.
 * - `unavailable`: Das Modell lieferte nichts Brauchbares (Plan: 200 mit
 *   `summary: null`); der Chat bleibt nutzbar.
 */
export type SummaryResponse =
  | { status: "empty"; summary: null }
  | { status: "stale"; summary: null }
  | { status: "ready"; summary: SummaryView }
  | { status: "unavailable"; summary: null };

export const SUMMARY_MESSAGES = {
  failed: "Die Zusammenfassung konnte gerade nicht erzeugt werden. Bitte versuche es erneut.",
  upstreamFailed:
    "Die Zusammenfassung konnte gerade nicht erzeugt werden. Bitte versuche es in einem Moment erneut.",
  timeout: "Die Zusammenfassung hat zu lange gedauert. Bitte versuche es erneut.",
  unavailable: "Zusammenfassung gerade nicht verfügbar.",
} as const;

export interface SummaryChunkRef {
  chunkId: string;
  tokenCount: number;
}

export interface SummaryDocumentChunks {
  documentId: string;
  /** In Dokumentreihenfolge (`chunk_index`). */
  chunks: readonly SummaryChunkRef[];
}

/**
 * Positionen 0 … n−1 in einer Reihenfolge, die das Dokument gleichmäßig
 * abdeckt: Anfang, Mitte, Viertel, Dreiviertel, Achtel … Wer nach k
 * Einträgen aufhört, hat k Stellen quer durchs Dokument statt der ersten k.
 */
export function spreadOrder(n: number): number[] {
  if (n <= 0) return [];
  const order = [0];
  const seen = new Set(order);
  for (let depth = 1; seen.size < n && depth <= 32; depth++) {
    const parts = 2 ** depth;
    for (let k = 1; k < parts; k += 2) {
      const position = Math.floor((k * n) / parts);
      if (!seen.has(position)) {
        seen.add(position);
        order.push(position);
      }
    }
  }
  return order;
}

/**
 * Wählt die Chunks für den Prompt: abwechselnd aus jedem Dokument, dort
 * gleichmäßig verteilt (`spreadOrder`), bis Tokenbudget oder Höchstzahl
 * erreicht sind. Ein Chunk, der nicht mehr passt, wird übersprungen, ein
 * kleinerer dahinter darf noch.
 *
 * Abwechselnd, damit eine große Quelle neben einer kleinen nicht das ganze
 * Budget nimmt. Bei sehr vielen Quellen kommen die späteren nicht mehr
 * vor; die Zusammenfassung ist dann ein Überblick über die ersten.
 *
 * Ergebnis in Dokument- und Positionsreihenfolge, damit `[n]` im Prompt
 * dem Lesefluss folgt.
 */
export function selectSummaryChunks(
  documents: readonly SummaryDocumentChunks[],
  budget = SUMMARY_INPUT_TOKENS,
  maxChunks = SUMMARY_MAX_CHUNKS,
): string[] {
  const queues = documents.map((document) =>
    spreadOrder(document.chunks.length).flatMap((position) => {
      const chunk = document.chunks[position];
      return chunk ? [chunk] : [];
    }),
  );
  const picked = new Set<string>();
  let used = 0;
  let progress = true;
  while (progress && picked.size < maxChunks) {
    progress = false;
    for (const queue of queues) {
      if (picked.size >= maxChunks) break;
      while (queue.length > 0) {
        const chunk = queue.shift();
        if (chunk && used + chunk.tokenCount <= budget) {
          picked.add(chunk.chunkId);
          used += chunk.tokenCount;
          progress = true;
          break;
        }
      }
    }
  }
  return documents.flatMap((document) =>
    document.chunks.filter((chunk) => picked.has(chunk.chunkId)).map((chunk) => chunk.chunkId),
  );
}

export interface SummaryOutput {
  summary: string;
  questions: string[];
}

export type SummaryValidation =
  | { success: true; value: SummaryOutput }
  | { success: false; error: Error };

const CITATION = /\[(\d+)\]/g;

function citationNumbers(text: string): number[] {
  return [...text.matchAll(CITATION)].map((match) => Number(match[1]));
}

function invalid(reason: string): SummaryValidation {
  return { success: false, error: new Error(reason) };
}

/**
 * Prüft und säubert die Antwort des Modells.
 *
 * Unbrauchbar ist: kein Objekt, leerer Text, kein einziger Beleg
 * (Architekturregel 2), ein Beleg außerhalb der Quellen (erfunden) oder
 * nicht genau drei Fragen. Die Route macht daraus `summary: null`, statt
 * einen unbelegten Text als Überblick zu cachen.
 */
export function validateSummaryOutput(value: unknown, sourceCount: number): SummaryValidation {
  if (typeof value !== "object" || value === null) return invalid("kein Objekt");
  const { summary, questions } = value as Record<string, unknown>;

  if (typeof summary !== "string") return invalid("summary fehlt");
  const text = stripControlChars(summary).trim();
  if (text.length === 0) return invalid("summary ist leer");
  if (text.length > MAX_SUMMARY_CHARS) return invalid("summary ist zu lang");
  const numbers = citationNumbers(text);
  if (numbers.length === 0) return invalid("summary ohne Beleg");
  if (numbers.some((n) => n < 1 || n > sourceCount)) return invalid("Beleg außerhalb der Quellen");

  if (!Array.isArray(questions)) return invalid("questions fehlt");
  const cleaned = questions.map((question) =>
    typeof question === "string"
      ? stripControlChars(question).replace(CITATION, "").replace(/\s+/g, " ").trim()
      : "",
  );
  const distinct = [...new Set(cleaned.filter((question) => question.length > 0))];
  if (distinct.length !== SUMMARY_QUESTION_COUNT || cleaned.length !== SUMMARY_QUESTION_COUNT) {
    return invalid("nicht genau drei Fragen");
  }
  if (distinct.some((question) => question.length > MAX_SUGGESTION_CHARS)) {
    return invalid("Frage zu lang");
  }

  return { success: true, value: { summary: text, questions: distinct } };
}

/**
 * Die Sätze der Zusammenfassung, die `[index]` zitieren. Daran richtet sich
 * der Ausschnitt der Belegkarte aus: Er soll die Stelle zeigen, die die
 * Aussage trägt, und nicht den Anfang des Chunks (Live-Befund L2).
 */
export function citingStatements(text: string, index: number): string {
  const marker = `[${index}]`;
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => sentence.includes(marker))
    .join(" ")
    .replace(CITATION, " ");
}
