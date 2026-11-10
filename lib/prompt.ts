import { MAX_CHUNK_CHARS } from "@/lib/chunk";
import type { RetrievedChunk } from "@/lib/retrieval";

/**
 * Prompt-Bau.
 *
 * Die eine Regel, die dieses Produkt ausmacht: Antworten kommen ausschließlich
 * aus den mitgelieferten Quellen. Der Systemprompt sagt das nicht nur, er
 * gibt dem Modell auch einen erlaubten Ausweg ("steht nicht in den Quellen"),
 * weil ein Modell ohne Ausweg lieber halluziniert als zuzugeben, dass es
 * nichts weiß.
 */

/** Eine Quelle, wie sie im UI als Beleg erscheint. */
export interface Citation {
  /** 1-basierte Nummer, wie sie im Antworttext als [1] steht. */
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  page: number | null;
  /** Link auf die Originaldatei, bei Seiten mit `#page=N`. */
  href: string;
  /** Gekürzter Auszug, damit der Nutzer den Beleg ohne Klick prüfen kann. */
  snippet: string;
}

export const SYSTEM_PROMPT = `Du bist Notebook, ein Assistent, der Fragen ausschließlich anhand der mitgelieferten Quellen beantwortet.

Regeln, die nicht verhandelbar sind:
1. Nutze ausschließlich die Inhalte aus den nummerierten Quellen. Kein Vorwissen, keine Vermutungen, keine Ergänzungen von außen.
2. Belege jede inhaltliche Aussage mit der Nummer der Quelle, aus der sie stammt, in eckigen Klammern: [1] oder [2][3]. Mehrere Belege direkt hintereinander, keine Sammelbelege am Absatzende.
3. Steht die Antwort nicht in den Quellen, schreibe: "Das steht nicht in den bereitgestellten Quellen." Nenne in diesem Fall, welche Information fehlt. Erfinde nichts.
4. Wenn Quellen sich widersprechen, benenne den Widerspruch und belege beide Seiten.
5. Antworte auf Deutsch, sachlich und knapp. Keine Einleitung, keine Wiederholung der Frage.
6. Verweise auf Seiten nur über die Quellennummern. Seitenzahlen in deinem Fließtext sind nicht nötig, das UI zeigt sie am Beleg an.`;

/** Kürzt langen Chunk-Text für den Prompt, ohne mitten im Wort zu schneiden. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()} …`;
}

function snippet(text: string, maxChars = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return truncate(clean, maxChars);
}

/**
 * Link auf die Originaldatei, bei PDFs mit Seitenanker.
 *
 * Die Datei liegt seit Schritt 2 in `documents.file_bytes` und wird von
 * GET /api/documents/[id]/file ausgeliefert. `#page=N` versteht der
 * PDF-Viewer von Chrome, Edge und Firefox; Safari öffnet auf Seite 1.
 */
export function citationHref(documentId: string, page: number | null): string {
  const base = `/api/documents/${encodeURIComponent(documentId)}/file`;
  return page === null ? base : `${base}#page=${page}`;
}

/**
 * Baut die Belegliste, die im UI gezeigt wird und auf die der Prompt verweist.
 * Nummer `n` hier ist `[n]` im Antworttext.
 */
export function buildCitations(chunks: readonly RetrievedChunk[]): Citation[] {
  return chunks.map((chunk, index) => ({
    index: index + 1,
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    page: chunk.page,
    href: citationHref(chunk.documentId, chunk.page),
    snippet: snippet(chunk.content),
  }));
}

/**
 * Titel landen in einem Attribut: Anführungszeichen und spitze Klammern
 * würden das Attribut oder den Tag beenden. Der Titel kommt aus dem
 * Dateinamen, also vom Nutzer.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Text aus Dokument oder Frage darf keinen Quellenblock öffnen oder
 * schließen. Sonst endet ein Block vorzeitig, und was danach steht, liest
 * das Modell als eigene Anweisung oder als zusätzliche Quelle. Nur die
 * Block-Tags werden entschärft, der übrige Text bleibt wörtlich, damit
 * Zitate und Zahlen wie „< 5 %“ unverändert ankommen.
 */
export function neutralizeSourceTags(text: string): string {
  return text.replace(/<(\s*\/?\s*quelle)/gi, "‹$1");
}

/**
 * Baut den User-Prompt: Quellenblöcke, dann die Frage.
 *
 * Jeder Block trägt seine Metadaten sichtbar im Kopf. Das Modell soll die
 * Seitenzahl beim Zitieren nicht raten müssen, und wir können im Log prüfen,
 * welche Quelle es tatsächlich benutzt hat.
 */
export function buildUserPrompt(
  question: string,
  chunks: readonly RetrievedChunk[],
): string {
  if (chunks.length === 0) {
    return `Quellen:\n(keine Treffer)\n\nFrage: ${neutralizeSourceTags(question)}`;
  }

  const blocks = chunks.map((chunk, index) => {
    const page = chunk.page === null ? "ohne Seitenangabe" : `Seite ${chunk.page}`;
    return [
      `<quelle nr="${index + 1}" dokument="${escapeAttribute(chunk.documentTitle)}" ${page}>`,
      // Kürzt nur, was über dem Chunk-Maximum liegt (Altbestand, Wort ohne
      // Leerzeichen). Früher 2.400 Zeichen: Chunks bis 2.880 Zeichen verloren
      // ihr Ende, ohne dass es jemand sah.
      neutralizeSourceTags(truncate(chunk.content, MAX_CHUNK_CHARS)),
      "</quelle>",
    ].join("\n");
  });

  return [
    "Quellen:",
    "",
    blocks.join("\n\n"),
    "",
    `Frage: ${neutralizeSourceTags(question)}`,
    "",
    "Antworte nur anhand dieser Quellen und belege jede Aussage mit [n].",
  ].join("\n");
}

/**
 * Prüft, ob eine Antwort überhaupt Belege enthält, und welche Nummern benutzt
 * wurden. Das ist die Grundlage für den Eval-Score und für ein UI-Warnzeichen
 * bei unbelegten Antworten.
 *
 * TODO(Schritt 4): Im Chat-UI als "unbelegt"-Hinweis anzeigen, wenn
 * `usedCitationNumbers` leer ist und die Antwort nicht der Verweigerungstext
 * ist.
 */
export function extractCitationNumbers(answer: string): number[] {
  const found = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed)) found.add(parsed);
  }
  return [...found].sort((a, b) => a - b);
}
