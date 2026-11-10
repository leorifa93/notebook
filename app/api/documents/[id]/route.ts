import type { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db";

import { handleDeleteDocument } from "../handler";

/**
 * DELETE /api/documents/:id
 *
 * Entfernt eine Quelle; ihre Chunks gehen per ON DELETE CASCADE mit.
 */

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  return handleDeleteDocument(getDatabase(), id);
}
