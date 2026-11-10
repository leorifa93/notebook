import { NextResponse } from "next/server";

import { ConfigError } from "@/lib/env";
import { CONFIG_ERROR_MESSAGE } from "@/lib/errors";
import { IngestError, ingestUpload, readUpload, type IngestDeps } from "@/lib/ingest";
import { DEFAULT_NOTEBOOK_ID } from "@/lib/notebooks";
import { INGEST_RATE_LIMIT, clientIp, consumeRateLimit } from "@/lib/rate-limit";

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
    // Nach der Formularprüfung, vor allem Teuren: Parsen und Embeddings
    // laufen erst, wenn diese IP noch Kontingent hat.
    const rate = await consumeRateLimit(deps.db, clientIp(request), INGEST_RATE_LIMIT);
    if (!rate.allowed) {
      const minutes = Math.ceil(rate.retryAfterSeconds / 60);
      return NextResponse.json(
        {
          error: `Zu viele Uploads in kurzer Zeit. Bitte versuche es in ${minutes} ${minutes === 1 ? "Minute" : "Minuten"} erneut.`,
        },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
      );
    }

    const upload = await readUpload(file, deps.limits);
    const stored = await ingestUpload(upload, DEFAULT_NOTEBOOK_ID, deps);
    return NextResponse.json(stored, { status: 201 });
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Fehlt DATABASE_URL, scheitert schon das Rate-Limit. Kein Retry-Hinweis.
    if (error instanceof ConfigError) {
      console.error("[ingest] configuration missing", { error: error.message });
      return NextResponse.json({ error: CONFIG_ERROR_MESSAGE }, { status: 503 });
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
