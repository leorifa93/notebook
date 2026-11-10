import { extractText, getDocumentProxy } from "unpdf";

import { stripControlChars } from "@/lib/text";

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
 * Normalisiert PDF-Text: pdf.js liefert harte Zeilenumbrüche mitten im Satz
 * und teils doppelte Leerzeichen. Beides verschlechtert Chunking und
 * Embeddings, deshalb glätten wir es hier zentral.
 */
function normalizeText(raw: string): string {
  return stripControlChars(raw.replace(/\r\n?/g, "\n"))
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
    const { totalPages, text } = await extractText(pdf, { mergePages: false });

    const pages: PdfPage[] = text.map((pageText, index) => ({
      page: index + 1,
      text: normalizeText(pageText),
    }));

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
  const text = stripControlChars(decoded.replace(/\r\n?/g, "\n")).trim();
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
