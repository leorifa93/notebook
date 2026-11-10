import { NextResponse } from "next/server";

import type { Queryable } from "@/lib/db";
import { deleteDocument, getNotebook, isUuid, listDocuments } from "@/lib/documents";
import { DEFAULT_NOTEBOOK_ID } from "@/lib/notebooks";

/**
 * Logik hinter GET /api/documents und DELETE /api/documents/:id, getrennt von
 * den Route-Dateien, damit die Tests sie gegen PGlite aufrufen können.
 */

function serverError(context: string, error: unknown): NextResponse {
  console.error(`[documents] ${context} failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
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
