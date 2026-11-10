import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { handleGetDocumentFile } from "@/app/api/documents/handler";
import { handleIngest } from "@/app/api/ingest/handler";

import { stubEmbed } from "../helpers/embeddings";
import { fileFrom, readFixture, uploadRequest } from "../helpers/fixtures";
import { createTestDatabase } from "../helpers/pglite";

/** GET /api/documents/:id/file — Ziel des Beleg-Sprungs. */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM documents; DELETE FROM rate_limit_events;");
});

async function upload(file: File): Promise<string> {
  const response = await handleIngest(uploadRequest(file), { db, embed: stubEmbed });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("GET /api/documents/:id/file", () => {
  it("liefert das PDF byte-gleich und inline aus", async () => {
    const bytes = await readFixture("muster-mietvertrag.pdf");
    const id = await upload(fileFrom(bytes, "muster-mietvertrag.pdf", "application/pdf"));

    const response = await handleGetDocumentFile(db, id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''muster-mietvertrag.pdf",
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(bytes);
  });

  it("liefert Markdown nie als HTML, sondern als Klartext", async () => {
    const markdown = "# Titel\n\n<script>alert(1)</script>";
    const id = await upload(fileFrom(markdown, "notiz.md", "text/markdown"));

    const response = await handleGetDocumentFile(db, id);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(markdown);
  });

  it("kodiert Umlaute und Sonderzeichen im Dateinamen", async () => {
    const id = await upload(fileFrom("Inhalt", 'Übersicht "neu".txt', "text/plain"));
    const response = await handleGetDocumentFile(db, id);
    expect(response.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''%C3%9Cbersicht%20%22neu%22.txt",
    );
  });

  it("antwortet 400 für eine ungültige und 404 für eine unbekannte ID", async () => {
    expect((await handleGetDocumentFile(db, "kein-uuid")).status).toBe(400);
    const missing = await handleGetDocumentFile(db, "00000000-0000-4000-8000-0000000000ff");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe(
      "Die Quelle gibt es nicht (mehr).",
    );
  });

  it("meldet eine Zeile ohne gespeicherte Datei als 404 mit eigenem Text", async () => {
    const id = await upload(fileFrom("Inhalt", "alt.txt", "text/plain"));
    await db.query("UPDATE documents SET file_bytes = NULL WHERE id = $1", [id]);
    const response = await handleGetDocumentFile(db, id);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain(
      "keine Originaldatei",
    );
  });
});
