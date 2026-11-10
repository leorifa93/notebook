import { NextResponse } from "next/server";

import type { Queryable } from "@/lib/db";
import { CONFIG_ERROR_MESSAGE, isConfigError } from "@/lib/errors";
import {
  deleteDocument,
  getDocumentFile,
  getNotebook,
  isUuid,
  listDocuments,
  type DocumentFile,
} from "@/lib/documents";
import { DEFAULT_NOTEBOOK_ID } from "@/lib/notebooks";

/**
 * Logik hinter GET /api/documents und DELETE /api/documents/:id, getrennt von
 * den Route-Dateien, damit die Tests sie gegen PGlite aufrufen können.
 */

function serverError(context: string, error: unknown): NextResponse {
  console.error(`[documents] ${context} failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
  if (isConfigError(error)) {
    return NextResponse.json({ error: CONFIG_ERROR_MESSAGE }, { status: 503 });
  }
  return NextResponse.json(
    { error: "Die Quellen konnten gerade nicht geladen werden." },
    { status: 500 },
  );
}

export async function handleListDocuments(db: Queryable): Promise<NextResponse> {
  try {
    const notebook = await getNotebook(db, DEFAULT_NOTEBOOK_ID);
    if (!notebook) {
      // Passiert, wenn db/schema.sql auf dieser Datenbank noch nicht in der
      // Fassung von Schritt 2 lief. Klar sagen, statt eine leere Liste zu zeigen.
      return NextResponse.json(
        { error: "Das Notebook „Demo“ fehlt. Ist db/schema.sql eingespielt?" },
        { status: 500 },
      );
    }
    const documents = await listDocuments(db, notebook.id);
    return NextResponse.json({ notebook, documents });
  } catch (error) {
    return serverError("list", error);
  }
}

export async function handleDeleteDocument(
  db: Queryable,
  documentId: string,
): Promise<NextResponse> {
  if (!isUuid(documentId)) {
    return NextResponse.json({ error: "Ungültige Dokument-ID." }, { status: 400 });
  }
  try {
    const deleted = await deleteDocument(db, DEFAULT_NOTEBOOK_ID, documentId);
    if (!deleted) {
      return NextResponse.json({ error: "Die Quelle gibt es nicht (mehr)." }, { status: 404 });
    }
    return NextResponse.json({ id: documentId, deleted: true });
  } catch (error) {
    return serverError("delete", error);
  }
}

const FILE_EXTENSIONS: Record<DocumentFile["sourceType"], string> = {
  pdf: ".pdf",
  markdown: ".md",
  text: ".txt",
};

/**
 * Header für die Originaldatei.
 *
 * PDFs als `application/pdf`, damit der Browser-Viewer `#page=N` anspringt.
 * Markdown und Text immer als `text/plain`: Eine hochgeladene Datei darf nie
 * als HTML im Origin der App gerendert werden. `nosniff` verbietet dem
 * Browser, das selbst anders zu raten.
 */
function fileHeaders(file: DocumentFile, size: number): Headers {
  const contentType =
    file.sourceType === "pdf" ? "application/pdf" : "text/plain; charset=utf-8";
  const fileName = `${file.title}${FILE_EXTENSIONS[file.sourceType]}`;
  return new Headers({
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "X-Content-Type-Options": "nosniff",
    // Eine Quelle wird nie überschrieben, nur gelöscht; kurz cachen genügt.
    "Cache-Control": "private, max-age=300",
  });
}

export async function handleGetDocumentFile(
  db: Queryable,
  documentId: string,
): Promise<Response> {
  if (!isUuid(documentId)) {
    return NextResponse.json({ error: "Ungültige Dokument-ID." }, { status: 400 });
  }
  try {
    const file = await getDocumentFile(db, DEFAULT_NOTEBOOK_ID, documentId);
    if (!file) {
      return NextResponse.json({ error: "Die Quelle gibt es nicht (mehr)." }, { status: 404 });
    }
    if (!file.bytes) {
      return NextResponse.json(
        { error: "Für diese Quelle ist keine Originaldatei gespeichert." },
        { status: 404 },
      );
    }
    const bytes = new Uint8Array(file.bytes);
    return new Response(bytes, { status: 200, headers: fileHeaders(file, bytes.byteLength) });
  } catch (error) {
    return serverError("file", error);
  }
}
