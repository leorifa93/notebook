import { NextResponse } from "next/server";

import { IngestError, ingestUpload, readUpload, type IngestDeps } from "@/lib/ingest";
import { DEFAULT_NOTEBOOK_ID } from "@/lib/notebooks";

/**
 * Logik hinter POST /api/ingest, mit austauschbaren Abhängigkeiten.
 *
 * Getrennt von route.ts, weil Next.js in einer Route-Datei nur HTTP-Methoden
 * als Export erlaubt. Die Tests rufen diese Funktion mit PGlite und
 * Stub-Embeddings auf; die Route mit Supabase und OpenAI.
 */
export async function handleIngest(
  request: Request,
  deps: IngestDeps,
): Promise<NextResponse> {
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
    const upload = await readUpload(file, deps.limits);
    const stored = await ingestUpload(upload, DEFAULT_NOTEBOOK_ID, deps);
    return NextResponse.json(stored, { status: 201 });
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[ingest] failed", {
      fileName: file.name,
      sizeBytes: file.size,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Die Quelle konnte nicht gespeichert werden. Bitte versuche es erneut." },
      { status: 500 },
    );
  }
}
