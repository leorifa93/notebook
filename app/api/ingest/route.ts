import { NextResponse } from "next/server";

import { IngestError, readUpload } from "@/lib/ingest";

/**
 * POST /api/ingest
 *
 * Nimmt eine Quelle (PDF, Markdown, Text) entgegen:
 *
 *   1. Datei lesen und prüfen → readUpload()     (lib/ingest.ts)
 *   2. Parsen                 → parsePdf() bzw. parseTextSource() (lib/pdf.ts)
 *   3. Chunking, Embeddings und Speichern folgen im nächsten Commit.
 *
 * Bewusst als `runtime = "nodejs"`: pg und pdf.js brauchen Node-APIs, auf der
 * Edge-Runtime laufen sie nicht.
 */

export const runtime = "nodejs";
// Parsing und Embedding dauern bei großen PDFs länger als die 10s, die Vercel
// als Default für Hobby-Deployments setzt. 60s ist das Maximum im Hobby-Plan.
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Der Request-Body ist kein gültiges Multipart-Formular." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Feld 'file' fehlt oder ist keine Datei." },
      { status: 400 },
    );
  }

  try {
    const upload = await readUpload(file);
    return NextResponse.json(
      {
        error: "Speichern ist noch nicht implementiert.",
        received: { title: upload.title, pageCount: upload.pageCount },
      },
      { status: 501 },
    );
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
