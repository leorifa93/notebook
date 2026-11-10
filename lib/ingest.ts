import type { SourcePage } from "@/lib/chunk";
import { MAX_FILE_BYTES, MAX_PDF_PAGES, formatMegabytes } from "@/lib/limits";
import {
  PdfPageLimitError,
  detectSourceType,
  parsePdf,
  parseTextSource,
  type ParsedPdf,
} from "@/lib/pdf";

/**
 * Ingest-Pipeline ohne HTTP: Datei prüfen und lesen.
 *
 * Die Route (app/api/ingest/route.ts) übersetzt nur noch `IngestError` in
 * eine Antwort. So lässt sich jeder Fehlerfall ohne Next.js testen, und die
 * Statuscodes stehen an einer Stelle.
 */

export type SourceType = "pdf" | "text" | "markdown";

/** Fehler, die der Nutzer sehen soll: deutscher Text, passender Status. */
export class IngestError extends Error {
  constructor(
    readonly status: 400 | 413 | 415 | 422 | 429 | 502,
    message: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

export interface IngestLimits {
  maxFileBytes: number;
  maxPdfPages: number;
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxPdfPages: MAX_PDF_PAGES,
};

export interface ParsedUpload {
  title: string;
  sourceType: SourceType;
  mimeType: string;
  /** Originalbytes, unverändert; landen als `documents.file_bytes`. */
  bytes: Uint8Array;
  /** 0 bei Quellen ohne Seiten. */
  pageCount: number;
  pages: SourcePage[];
}

/** Dateiname ohne Endung als Titel; Pfadanteile mancher Browser entfernt. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const withoutExtension = base.replace(/\.(pdf|md|markdown|txt)$/i, "").trim();
  return withoutExtension || "Unbenannte Quelle";
}

function mimeTypeFor(sourceType: SourceType): string {
  if (sourceType === "pdf") return "application/pdf";
  if (sourceType === "markdown") return "text/markdown";
  return "text/plain";
}

/**
 * Prüft Größe und Typ und liest den Inhalt seitenweise.
 *
 * Reihenfolge: billige Prüfungen zuerst (Größe, Typ), dann Parsen. Scans und
 * Dateien ohne Text werden abgelehnt, nicht leer indexiert: Eine Quelle, die
 * in der Sidebar steht, aber nichts beantworten kann, wäre ein stiller Fehler.
 */
export async function readUpload(
  file: File,
  limits: IngestLimits = DEFAULT_LIMITS,
): Promise<ParsedUpload> {
  if (file.size === 0) {
    throw new IngestError(400, "Die Datei ist leer.");
  }

  if (file.size > limits.maxFileBytes) {
    throw new IngestError(
      413,
      `Die Datei ist zu groß. Erlaubt sind höchstens ${formatMegabytes(limits.maxFileBytes)}.`,
    );
  }

  const detected = detectSourceType(file.name, file.type);
  if (detected === "unsupported") {
    throw new IngestError(
      415,
      "Dieser Dateityp wird nicht unterstützt. Erlaubt sind PDF, Markdown und Text.",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const title = titleFromFileName(file.name);

  if (detected === "pdf") {
    let parsed: ParsedPdf;
    try {
      parsed = await parsePdf(bytes, { maxPages: limits.maxPdfPages });
    } catch (error) {
      if (error instanceof PdfPageLimitError) {
        throw new IngestError(
          413,
          `Das PDF hat ${error.pageCount} Seiten. Erlaubt sind höchstens ${error.maxPages}.`,
        );
      }
      throw new IngestError(400, "Die Datei ist kein lesbares PDF.");
    }

    if (parsed.probablyScanned || parsed.pages.every((page) => page.text === "")) {
      throw new IngestError(
        422,
        "Das PDF enthält keinen auslesbaren Text, vermutlich ein Scan. Texterkennung (OCR) wird nicht unterstützt.",
      );
    }

    return {
      title,
      sourceType: "pdf",
      mimeType: mimeTypeFor("pdf"),
      bytes,
      pageCount: parsed.pageCount,
      pages: parsed.pages,
    };
  }

  let pages: SourcePage[];
  try {
    pages = parseTextSource(bytes);
  } catch {
    throw new IngestError(422, "Die Textdatei ist nicht UTF-8-kodiert.");
  }

  if (pages.length === 0) {
    throw new IngestError(422, "Die Datei enthält keinen Text.");
  }

  return {
    title,
    sourceType: detected,
    mimeType: mimeTypeFor(detected),
    bytes,
    pageCount: 0,
    pages,
  };
}
