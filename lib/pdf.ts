import { getDocumentProxy } from "unpdf";

import { cleanText } from "@/lib/text";

/**
 * PDF-Parsing.
 *
 * Ergebnis ist bewusst seitenweise: `pages[i]` ist der Text von Seite `i + 1`.
 * Die Seitenzahl wandert später als Metadatum an jeden Chunk, damit ein Beleg
 * im Chat wirklich auf die richtige Seite springen kann. Wer hier
 * `mergePages: true` setzt, verliert genau diese Information.
 */

export interface PdfPage {
  /** 1-basiert, wie im PDF-Viewer angezeigt. */
  page: number;
  text: string;
}

export interface ParsedPdf {
  pages: PdfPage[];
  pageCount: number;
  /** True, wenn fast kein Text extrahierbar war — Hinweis auf ein Scan-PDF. */
  probablyScanned: boolean;
}

/**
 * Das PDF hat mehr Seiten als erlaubt. Eigene Klasse, damit die Route daraus
 * einen 413 machen kann, statt einen generischen Parse-Fehler zu melden.
 */
export class PdfPageLimitError extends Error {
  constructor(
    readonly pageCount: number,
    readonly maxPages: number,
  ) {
    super(`PDF hat ${pageCount} Seiten, erlaubt sind ${maxPages}.`);
    this.name = "PdfPageLimitError";
  }
}

export interface ParsePdfOptions {
  /** Höchstzahl Seiten; geprüft, bevor Text extrahiert wird. */
  maxPages?: number;
}

/** Unter dieser Zeichenzahl pro Seite gilt ein PDF als bildbasiert. */
const MIN_CHARS_PER_PAGE = 40;

/**
 * Ab dieser Länge gilt ein wörtlich wiederholter Abschnitt einer Seite als
 * Export-Artefakt statt als Inhalt. Echte Wiederholungen auf derselben Seite
 * (Fußzeile, Tabellenkopf, ein zitierter Satz) bleiben weit darunter.
 */
export const MIN_REPEATED_BLOCK_CHARS = 500;

/** Abstand in Punkt, unter dem zwei gleiche Textstücke als dieselbe Stelle gelten. */
const SAME_POSITION_TOLERANCE = 1;

/** Die Felder eines pdf.js-`TextItem`, die das Zusammensetzen braucht. */
export interface PdfTextItem {
  str: string;
  hasEOL: boolean;
  /** `[a, b, c, d, e, f]`; `e`/`f` ist die Position, `a`/`d` die Schriftgröße. */
  transform: number[];
}

/**
 * Setzt den Text einer Seite aus den pdf.js-Stücken zusammen, wie
 * `extractText` von unpdf, verwirft aber deckungsgleich doppelt gezeichneten
 * Text.
 *
 * Layout-Programme zeichnen Text für Pseudo-Fettdruck oder Ebenen zweimal an
 * dieselbe Stelle. Im Bild sieht man das nicht, pdf.js liefert aber beide
 * Kopien (Live-Befund L2: ein Lebenslauf kam so mit rund 50 % mehr Text an).
 * `pdftotext` filtert das ebenso.
 */
export function joinTextItems(items: readonly PdfTextItem[]): string {
  const seen = new Map<string, Array<readonly number[]>>();
  let text = "";
  for (const item of items) {
    const key = item.str.trim();
    if (key.length > 0) {
      const positions = seen.get(key) ?? [];
      const duplicate = positions.some((other) =>
        [0, 3, 4, 5].every(
          (index) =>
            Math.abs((other[index] ?? 0) - (item.transform[index] ?? 0)) <= SAME_POSITION_TOLERANCE,
        ),
      );
      if (duplicate) {
        // Der Zeilenumbruch kann an der Kopie hängen statt am Original.
        if (item.hasEOL && !text.endsWith("\n")) text += "\n";
        continue;
      }
      positions.push(item.transform);
      seen.set(key, positions);
    }
    text += item.str + (item.hasEOL ? "\n" : "");
  }
  return text;
}

/** Länge der Stichprobe, über die `removeRepeatedBlocks` frühere Stellen findet. */
const PROBE_CHARS = 64;

const isSpace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);

/**
 * Entfernt spätere Kopien wörtlich wiederholter Abschnitte ab
 * `minChars` Zeichen innerhalb einer Seite.
 *
 * Zweiter Teil von Live-Befund L2: Derselbe Abschnitt lag ein zweites Mal
 * versetzt in der Textebene, unsichtbar im Bild. Im Index wären daraus fast
 * gleiche Chunks geworden, die sich alle Belegplätze teilen. Die erste Kopie
 * bleibt, es geht also kein Inhalt verloren, nur seine Wiederholung. Schnitte
 * liegen immer an Wortgrenzen, damit kein halbes Wort übrig bleibt.
 */
export function removeRepeatedBlocks(text: string, minChars = MIN_REPEATED_BLOCK_CHARS): string {
  const firstAt = new Map<string, number[]>();
  const remember = (position: number): void => {
    const probe = text.slice(position, position + PROBE_CHARS);
    const positions = firstAt.get(probe) ?? [];
    // Wenige Kandidaten genügen; sonst wird gleichförmiger Text quadratisch.
    if (positions.length < 4) positions.push(position);
    firstAt.set(probe, positions);
  };

  let result = "";
  let position = 0;
  while (position < text.length) {
    const atWordStart = isSpace(text[position - 1]) && !isSpace(text[position]);
    let skip = 0;
    if (atWordStart && position + minChars <= text.length) {
      for (const earlier of firstAt.get(text.slice(position, position + PROBE_CHARS)) ?? []) {
        let length = 0;
        // Nicht überlappend: Die Kopie darf nicht in ihr eigenes Original reichen.
        while (
          earlier + length < position &&
          position + length < text.length &&
          text[earlier + length] === text[position + length]
        ) {
          length += 1;
        }
        // Auf die letzte Wortgrenze zurück, sonst bliebe ein Wortrest stehen.
        if (!isSpace(text[position + length])) {
          while (length > 0 && !isSpace(text[position + length - 1])) length -= 1;
        }
        if (length >= minChars && length > skip) skip = length;
      }
    }
    if (skip > 0) {
      position += skip;
      continue;
    }
    remember(position);
    result += text[position];
    position += 1;
  }
  return result;
}

/**
 * Normalisiert PDF-Text: pdf.js liefert harte Zeilenumbrüche mitten im Satz
 * und teils doppelte Leerzeichen. Beides verschlechtert Chunking und
 * Embeddings, deshalb glätten wir es hier zentral.
 */
function normalizeText(raw: string): string {
  return cleanText(raw.replace(/\r\n?/g, "\n"))
    .replace(/[ \t]+/g, " ")
    // Bindestrich am Zeilenende zusammenführen: "Soft-\nware" -> "Software"
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Liest ein PDF aus einem Buffer und gibt den Text je Seite zurück.
 *
 * Das Seitenlimit wird vor der Textextraktion geprüft: ein 500-Seiten-PDF
 * soll nicht erst komplett gelesen werden, um dann abgelehnt zu werden.
 */
export async function parsePdf(
  data: ArrayBuffer | Uint8Array,
  options: ParsePdfOptions = {},
): Promise<ParsedPdf> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  // Ein leeres Buffer erreicht pdf.js sonst mit einer kryptischen Meldung.
  if (bytes.byteLength === 0) {
    throw new Error("Die Datei ist leer.");
  }

  // pdf.js übernimmt den Buffer (transfer) und macht ihn danach unbrauchbar.
  // Der Ingest speichert dieselben Bytes noch als Original, deshalb eine Kopie.
  const pdf = await getDocumentProxy(bytes.slice());
  try {
    if (options.maxPages !== undefined && pdf.numPages > options.maxPages) {
      throw new PdfPageLimitError(pdf.numPages, options.maxPages);
    }
    // Seite für Seite statt `extractText`: Die Stücke brauchen ihre Position,
    // und die Seitenzahl bleibt am Text (AGENTS.md, Regel 4).
    const totalPages = pdf.numPages;
    const pages: PdfPage[] = [];
    for (let number = 1; number <= totalPages; number += 1) {
      const content = await (await pdf.getPage(number)).getTextContent();
      // `TextMarkedContent` (ohne `str`) trägt keinen Text.
      const items = content.items.flatMap((item) => ("str" in item ? [item] : []));
      const text = normalizeText(removeRepeatedBlocks(normalizeText(joinTextItems(items))));
      pages.push({ page: number, text });
    }

    const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);
    const probablyScanned =
      totalPages > 0 && totalChars / totalPages < MIN_CHARS_PER_PAGE;

    return { pages, pageCount: totalPages, probablyScanned };
  } finally {
    // pdf.js hält Seitenobjekte und Worker-Ressourcen. In einer warmen
    // Vercel-Instanz blieben sie sonst pro Upload im Speicher liegen.
    await pdf.destroy();
  }
}

/**
 * Liest Markdown oder reinen Text als *eine* Seite ohne Seitenzahl.
 *
 * Kein Markdown-Rendering: Überschriften und Listen bleiben als Text stehen,
 * das schadet weder der Volltextsuche noch dem Embedding. Kein gültiges UTF-8
 * wirft, statt Ersatzzeichen still in den Index zu schreiben.
 */
export function parseTextSource(data: Uint8Array): { page: null; text: string }[] {
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  const text = cleanText(decoded.replace(/\r\n?/g, "\n")).trim();
  return text ? [{ page: null, text }] : [];
}

/** Erkennt den Quelltyp anhand des MIME-Typs bzw. der Dateiendung. */
export function detectSourceType(
  fileName: string,
  mimeType: string,
): "pdf" | "text" | "markdown" | "unsupported" {
  const lower = fileName.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (mimeType === "text/markdown" || lower.endsWith(".md")) return "markdown";
  // Nur text/plain, nicht jedes text/*: HTML, CSV oder Quelltext landeten sonst
  // mit Tags und Trennzeichen im Index.
  if (mimeType === "text/plain" || lower.endsWith(".txt")) return "text";
  return "unsupported";
}
