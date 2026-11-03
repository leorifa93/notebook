import { NextResponse } from "next/server";

/**
 * POST /api/ingest
 *
 * Nimmt ein PDF entgegen und legt Dokument + Chunks in Postgres ab.
 *
 * Schritt 1: nur Validierung und ein klarer 501. Die Pipeline selbst ist in
 * den lib-Modulen vorbereitet und wird in Schritt 2 hier verdrahtet:
 *
 *   1. Datei lesen           → await request.formData()
 *   2. Parsen                → parsePdf()        (lib/pdf.ts)
 *   3. Chunking              → chunkPages()      (lib/chunk.ts)
 *   4. Embeddings            → embedTexts()      (lib/embeddings.ts)
 *   5. Schreiben             → withTransaction() (lib/db.ts), Schema db/schema.sql
 *
 * Bewusst als `runtime = "nodejs"`: pg und pdf.js brauchen Node-APIs, auf der
 * Edge-Runtime laufen sie nicht.
 */

export const runtime = "nodejs";
// Parsing und Embedding dauern bei großen PDFs länger als die 10s, die Vercel
// als Default für Hobby-Deployments setzt. 60s ist das Maximum im Hobby-Plan.
export const maxDuration = 60;

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

export async function POST(request: Request): Promise<NextResponse> {
  // FormData lesen; bei kaputtem Body wirft das und landet im catch.
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

  if (file.size === 0) {
    return NextResponse.json({ error: "Die Datei ist leer." }, { status: 400 });
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `Datei zu groß. Maximum: ${MAX_FILE_BYTES / 1024 / 1024} MB.` },
      { status: 413 },
    );
  }

  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    return NextResponse.json(
      { error: "In Schritt 1 werden nur PDF-Dateien angenommen." },
      { status: 415 },
    );
  }

  // TODO(Schritt 2): parsePdf → chunkPages → embedTexts → INSERT in einer
  // Transaktion. Bis dahin sagen wir klar, dass hier noch nichts passiert,
  // statt eine Datei anzunehmen und stillschweigend zu verwerfen.
  return NextResponse.json(
    {
      error: "Upload ist noch nicht implementiert (Schritt 1: Gerüst).",
      hint: "Die Pipeline liegt bereit in lib/pdf.ts, lib/chunk.ts und lib/embeddings.ts.",
      received: { name: file.name, sizeBytes: file.size },
    },
    { status: 501 },
  );
}
