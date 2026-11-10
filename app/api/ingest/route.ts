import type { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db";
import { embedTexts } from "@/lib/embeddings";

import { handleIngest } from "./handler";

/**
 * POST /api/ingest
 *
 * Nimmt eine Quelle (PDF, Markdown, Text) entgegen und legt sie vollständig
 * im Default-Notebook ab:
 *
 *   1. Prüfen und lesen  → readUpload()    (lib/ingest.ts, lib/pdf.ts)
 *   2. Chunking          → chunkPages()    (lib/chunk.ts)
 *   3. Embeddings        → embedTexts()    (lib/embeddings.ts)
 *   4. Speichern         → insertDocumentWithChunks() (lib/documents.ts),
 *                          Dokument, Datei und Chunks in einer Transaktion
 *
 * Antwort 201: `{ id, title, sourceType, pageCount, chunkCount }`. Bewusst
 * kein Stream: Ein Demo-PDF ist in wenigen Sekunden fertig.
 *
 * Bewusst als `runtime = "nodejs"`: pg und pdf.js brauchen Node-APIs, auf der
 * Edge-Runtime laufen sie nicht.
 */

export const runtime = "nodejs";
// Parsing und Embedding dauern bei großen PDFs länger als die 10s, die Vercel
// als Default für Hobby-Deployments setzt. 60s ist das Maximum im Hobby-Plan.
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  return handleIngest(request, { db: getDatabase(), embed: embedTexts });
}
