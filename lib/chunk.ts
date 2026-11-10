
/**
 * Chunking.
 *
 * Zielgröße: 500–800 Tokens mit etwa 15 % Überlappung. Kleiner wird der
 * Kontext zu flach für Fragen, die über einen Absatz hinausgehen; größer
 * verwässert die Vektorsuche und kostet Prompt-Platz.
 *
 * Wir haben keinen Tokenizer im Projekt (kein natives Modul, kein Extra-Paket
 * für einen Testjob), deshalb schätzen wir Tokens über Zeichen. Für deutschen
 * Fließtext liegt das Verhältnis stabil bei etwa 3,6 Zeichen pro Token —
 * konservativer als die englischen 4, damit wir nicht überschätzen.
 */

export const CHARS_PER_TOKEN = 3.6;

export interface ChunkOptions {
  /** Zielgröße in Tokens. */
  targetTokens?: number;
  /** Überlappung in Tokens. */
  overlapTokens?: number;
  /** Maximaltoleranz, bevor ein Absatz hart getrennt wird. */
  maxTokens?: number;
}

/**
 * Eine Seite als Eingabe fürs Chunking. `page` ist `null` bei Quellen ohne
 * Seiten (Markdown, Text) — eine erfundene Seitenzahl wäre im Beleg unehrlich.
 * `PdfPage` aus lib/pdf.ts ist damit kompatibel.
 */
export interface SourcePage {
  page: number | null;
  text: string;
}

export interface Chunk {
  /** 1-basierte Seitenzahl; `null` bei Quellen ohne Seiten (z. B. Markdown). */
  page: number | null;
  /** Position im Dokument, fortlaufend ab 0 über alle Seiten. */
  chunkIndex: number;
  /** Der eigentliche Text, so wie er zitiert wird. */
  content: string;
  /** Geschätzte Tokens, für die Spalte `chunks.token_count`. */
  tokenCount: number;
  /** Überschrift/Seitenkontext, der nur in das Embedding einfließt. */
  contextHeader: string;
}

const DEFAULTS: Required<ChunkOptions> = {
  targetTokens: 650,
  overlapTokens: 100, // ~15 % von 650
  maxTokens: 800,
};

/** Grobe Token-Schätzung; bewusst ohne externe Abhängigkeit. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Zerlegt Text in Absätze. Doppelte Umbrüche trennen Absätze, einzelne
 * Umbrüche gelten als Zeilenumbruch innerhalb eines Absatzes.
 */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Zerlegt einen beliebig langen String an Wortgrenzen in Stücke, die
 * garantiert in `maxTokens` passen.
 *
 * Das ist das Sicherheitsnetz für Text ohne Satzzeichen — Tabellen, die aus
 * dem PDF als eine lange Zeile kommen, oder ein Inhaltsverzeichnis. Ohne
 * diesen Schritt würde ein einzelner 10.000-Zeichen-Absatz entweder einen
 * Riesen-Chunk erzeugen oder (schlimmer) beim harten Abschneiden den Rest
 * des Textes verlieren. Genau dieser Verlust wäre im Chat unsichtbar: die
 * Antwort zitiert dann einfach eine Seite, deren hintere Hälfte nie
 * indexiert wurde.
 */
function hardSplitByWords(text: string, maxTokens: number): string[] {
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  const pieces: string[] = [];
  let rest = text.trim();

  while (rest.length > maxChars) {
    let cut = maxChars;
    // Auf die letzte Wortgrenze vor dem Limit zurückgehen, damit kein Wort
    // zerschnitten wird. Nur wenn das Stück gar keine Leerzeichen hat
    // (z. B. eine Base64-Zeile), wird hart geschnitten.
    const space = rest.lastIndexOf(" ", cut);
    if (space > maxChars * 0.5) cut = space;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) pieces.push(rest);
  return pieces.filter((piece) => piece.length > 0);
}

/**
 * Zerlegt einen zu langen Absatz satzweise und fasst Sätze zu Stücken
 * zusammen, die in die Zielgröße passen. Ohne diesen Schritt würde ein
 * einzelner langer Absatz (typisch in Verträgen) einen Chunk von 3000 Tokens
 * erzeugen.
 *
 * Jedes zurückgegebene Stück ist garantiert <= maxTokens, auch wenn ein
 * einzelner Satz länger ist als maxTokens.
 */
function splitLongParagraph(paragraph: string, maxTokens: number): string[] {
  if (estimateTokens(paragraph) <= maxTokens) return [paragraph];

  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let current = "";

  const pushSentence = (sentence: string) => {
    // Ein einzelner Satz über maxTokens (verschachtelte Aufzählung, fehlende
    // Punkte in einer Tabelle) wird an Wortgrenzen weiter zerlegt.
    for (const part of hardSplitByWords(sentence, maxTokens)) {
      const candidate = current ? `${current} ${part}` : part;
      if (estimateTokens(candidate) > maxTokens && current) {
        pieces.push(current);
        current = part;
      } else {
        current = candidate;
      }
    }
  };

  for (const sentence of sentences) pushSentence(sentence);
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Baut aus einem Absatz-Stück einen Chunk inklusive Überlappung zum Vorgänger.
 *
 * Die Überlappung kommt aus dem Ende des vorherigen Chunks, damit ein Satz,
 * der über die Grenze läuft, in beiden Chunks vollständig vorkommt.
 *
 * Wichtig: Die Überlappung zählt gegen `maxTokens`, nicht obendrauf. Sonst
 * würde ein Stück von 800 Tokens plus 100 Tokens Overlap einen 900-Token-
 * Chunk ergeben und das Budget reißen. Gekürzt wird deshalb ausschließlich
 * der *Overlap* — der ist ohnehin redundanter Text aus dem Vorgänger. `next`
 * bleibt immer vollständig erhalten; daran hängt, ob später Inhalt fehlt.
 */
function withOverlap(
  previous: string,
  next: string,
  overlapTokens: number,
  maxTokens: number,
): string {
  if (!previous) return next;

  // Wie viele Zeichen darf die Überlappung kosten, damit next komplett
  // hineinpasst? Mindestens 0, sonst geben wir lieber die Überlappung auf.
  const roomForOverlap = Math.floor(maxTokens * CHARS_PER_TOKEN) - next.length - 1;
  if (roomForOverlap <= 0) return next;

  const overlapChars = Math.min(Math.floor(overlapTokens * CHARS_PER_TOKEN), roomForOverlap);
  if (overlapChars <= 0) return next;

  const tail = previous.slice(-overlapChars);
  // Auf Wortgrenze schneiden, damit kein halbes Wort im Zitat steht.
  const firstSpace = tail.indexOf(" ");
  const cleanTail = firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
  const trimmedTail = cleanTail.trim();

  return trimmedTail ? `${trimmedTail} ${next}` : next;
}

/**
 * Chunked alle Seiten eines Dokuments.
 *
 * Seiten werden nie vermischt: ein Chunk gehört genau einer Seite, sonst wäre
 * die Seitenzahl im Beleg eine Lüge. Kurze Seiten (z. B. ein Deckblatt)
 * ergeben entsprechend einen kleinen Chunk — das ist gewollt.
 */
export function chunkPages(
  pages: readonly SourcePage[],
  documentTitle: string,
  options: ChunkOptions = {},
): Chunk[] {
  const { targetTokens, overlapTokens, maxTokens } = { ...DEFAULTS, ...options };
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const page of pages) {
    const paragraphs = splitParagraphs(page.text);
    if (paragraphs.length === 0) continue;

    const pieces = paragraphs.flatMap((paragraph) =>
      splitLongParagraph(paragraph, maxTokens),
    );

    let buffer = "";
    let previous = "";

    const flush = () => {
      const content = buffer.trim();
      if (!content) return;
      chunks.push({
        page: page.page,
        chunkIndex: chunkIndex++,
        content,
        tokenCount: estimateTokens(content),
        // Der Header hilft dem Embedding, "Seite 7, Vertrag X" von
        // "Seite 7, Anhang Y" zu unterscheiden. Er wird nicht mitzitiert.
        contextHeader:
          page.page === null ? documentTitle : `${documentTitle} · Seite ${page.page}`,
      });
      previous = content;
      buffer = "";
    };

    for (const piece of pieces) {
      if (estimateTokens(piece) > maxTokens) {
        // Kann nach splitLongParagraph nicht mehr passieren. Falls doch,
        // wird das Stück zerlegt statt abgeschnitten — Textverlust wäre
        // schlimmer als ein zu großer Chunk.
        flush();
        for (const part of hardSplitByWords(piece, maxTokens)) {
          buffer = withOverlap(previous, part, overlapTokens, maxTokens);
          flush();
        }
        continue;
      }

      const candidate = buffer ? `${buffer} ${piece}` : piece;
      if (estimateTokens(candidate) > targetTokens && buffer) {
        flush();
        buffer = withOverlap(previous, piece, overlapTokens, maxTokens);
      } else {
        buffer = candidate;
      }
    }

    flush();
  }

  return chunks;
}
