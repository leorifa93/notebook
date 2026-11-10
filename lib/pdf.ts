import { extractText, getDocumentProxy } from "unpdf";

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

/** Unter dieser Zeichenzahl pro Seite gilt ein PDF als bildbasiert. */
const MIN_CHARS_PER_PAGE = 40;

/**
 * Normalisiert PDF-Text: pdf.js liefert harte Zeilenumbrüche mitten im Satz
 * und teils doppelte Leerzeichen. Beides verschlechtert Chunking und
 * Embeddings, deshalb glätten wir es hier zentral.
 */
function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
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
 * TODO(Schritt 2): In app/api/ingest/route.ts aufrufen. Der Buffer kommt dort
 * aus `await file.arrayBuffer()`.
 */
export async function parsePdf(data: ArrayBuffer | Uint8Array): Promise<ParsedPdf> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  // Ein leeres Buffer erreicht pdf.js sonst mit einer kryptischen Meldung.
  if (bytes.byteLength === 0) {
    throw new Error("Die Datei ist leer.");
  }

  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  const pages: PdfPage[] = text.map((pageText, index) => ({
    page: index + 1,
    text: normalizeText(pageText),
  }));

  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  const probablyScanned =
    totalPages > 0 && totalChars / totalPages < MIN_CHARS_PER_PAGE;

  return { pages, pageCount: totalPages, probablyScanned };
}

/**
 * Erkennt den Quelltyp anhand des MIME-Typs bzw. der Dateiendung.
 * Text und Markdown sind vorgesehen, aber in Schritt 1 noch nicht geparst.
 */
export function detectSourceType(
  fileName: string,
  mimeType: string,
): "pdf" | "text" | "markdown" | "unsupported" {
  const lower = fileName.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (mimeType === "text/markdown" || lower.endsWith(".md")) return "markdown";
  if (mimeType.startsWith("text/") || lower.endsWith(".txt")) return "text";
  return "unsupported";
}
