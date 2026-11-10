import { getDatabase } from "@/lib/db";

import { handleGetDocumentFile } from "../../handler";

/**
 * GET /api/documents/:id/file
 *
 * Liefert die Originaldatei aus `documents.file_bytes`. Ziel der Belegkarten
 * im Chat: `…/file#page=N` öffnet das PDF auf der Seite des Belegs.
 */

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleGetDocumentFile(getDatabase(), id);
}
