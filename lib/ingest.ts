import { createHash } from "node:crypto";

import { chunkPages, type Chunk, type SourcePage } from "@/lib/chunk";
import type { Database } from "@/lib/db";
import {
  DuplicateDocumentError,
  findDocumentByHash,
  insertDocumentWithChunks,
  type StoredDocument,
} from "@/lib/documents";
import { MAX_FILE_BYTES, MAX_PDF_PAGES, formatMegabytes } from "@/lib/limits";
import {
  PdfPageLimitError,
  detectSourceType,
  parsePdf,
  parseTextSource,
  type ParsedPdf,
} from "@/lib/pdf";

/**
 * Ingest-Pipeline ohne HTTP: Datei prüfen, lesen, zerlegen, einbetten,
 * speichern.
 *
 * Die Route (app/api/ingest/route.ts) übersetzt nur noch `IngestError` in
 * eine Antwort. So lässt sich jeder Fehlerfall ohne Next.js testen, und die
 * Statuscodes stehen an einer Stelle.
 */

export type SourceType = "pdf" | "text" | "markdown";

/** Fehler, die der Nutzer sehen soll: deutscher Text, passender Status. */
export class IngestError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 415 | 422 | 429 | 502,
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
  /** SHA-256 der Originalbytes, hex; erkennt doppelte Uploads. */
  contentSha256: string;
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
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");

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
      contentSha256,
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
    contentSha256,
    pageCount: 0,
    pages,
  };
}

export interface IngestDeps {
  db: Database;
  embed: (texts: readonly string[]) => Promise<number[][]>;
  limits?: IngestLimits;
}

/**
 * Text, der eingebettet wird: Kontext-Header plus Inhalt. Der Header
 * („Vertrag · Seite 2") hilft der Vektorsuche, wird aber nicht zitiert und
 * steht deshalb nicht in `chunks.content`.
 */
export function embeddingInput(chunk: Chunk): string {
  return `${chunk.contextHeader}\n\n${chunk.content}`;
}

/**
 * Gelesene Datei → Chunks → Embeddings → eine Transaktion.
 *
 * Ein Fehler beim Embedding ist ein Fehler des Dienstes (502), nicht der
 * Datei; der Nutzer soll wissen, dass ein erneuter Versuch sinnvoll ist.
 */
export async function ingestUpload(
  upload: ParsedUpload,
  notebookId: string,
  deps: IngestDeps,
): Promise<StoredDocument> {
  // Vor den Embeddings: ein Duplikat soll nichts kosten.
  const existing = await findDocumentByHash(deps.db, notebookId, upload.contentSha256);
  if (existing) throw duplicateError(existing.title);

  const chunks = chunkPages(upload.pages, upload.title);
  if (chunks.length === 0) {
    throw new IngestError(422, "Die Datei enthält keinen Text.");
  }

  let embeddings: number[][];
  try {
    embeddings = await deps.embed(chunks.map(embeddingInput));
  } catch (error) {
    console.error("[ingest] embedding failed", {
      title: upload.title,
      chunkCount: chunks.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new IngestError(
      502,
      "Die Embeddings konnten gerade nicht erzeugt werden. Bitte versuche es gleich noch einmal.",
    );
  }

  try {
    return await insertDocumentWithChunks(
      deps.db,
      {
        notebookId,
        title: upload.title,
        sourceType: upload.sourceType,
        mimeType: upload.mimeType,
        pageCount: upload.pageCount,
        fileBytes: upload.bytes,
        contentSha256: upload.contentSha256,
      },
      chunks,
      embeddings,
    );
  } catch (error) {
    // Zwei gleichzeitige Uploads derselben Datei: Die Vorabprüfung sah bei
    // beiden „frei", der eindeutige Index lässt nur einen durch.
    if (error instanceof DuplicateDocumentError) throw duplicateError(upload.title);
    throw error;
  }
}

function duplicateError(existingTitle: string): IngestError {
  return new IngestError(
    409,
    `Diese Datei ist in diesem Notebook schon vorhanden („${existingTitle}“).`,
  );
}
