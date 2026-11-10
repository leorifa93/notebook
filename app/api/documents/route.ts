import type { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db";

import { handleListDocuments } from "./handler";

/**
 * GET /api/documents
 *
 * Quellen des Default-Notebooks für die Sidebar:
 * `{ notebook: { id, title }, documents: [{ id, title, sourceType, pageCount, chunkCount, sizeBytes, createdAt }] }`.
 */

export const runtime = "nodejs";
// Die Liste ändert sich mit jedem Upload; nie statisch vorrendern.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return handleListDocuments(getDatabase());
}
