import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { handleIngest } from "@/app/api/ingest/handler";
import { retrieve, type RetrievalDeps } from "@/lib/retrieval";

import { stubEmbed } from "../helpers/embeddings";
import { fileFrom, readFixture, uploadRequest } from "../helpers/fixtures";
import { createTestDatabase } from "../helpers/pglite";

/**
 * `retrieve()` gegen PGlite: echtes Hybrid-SQL, gestubbte Embeddings.
 * Bis Schritt 3 war nur das SQL getestet, nicht die Funktion drumherum.
 */

let db: PGlite;
let deps: RetrievalDeps;
let vertragId: string;
let notizId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  deps = { db, embed: stubEmbed };
  const ingestDeps = { db, embed: stubEmbed };
  const bytes = await readFixture("muster-mietvertrag.pdf");
  const vertrag = await handleIngest(
    uploadRequest(fileFrom(bytes, "muster-mietvertrag.pdf", "application/pdf")),
    ingestDeps,
  );
  vertragId = ((await vertrag.json()) as { id: string }).id;
  const notiz = await handleIngest(
    uploadRequest(fileFrom("Die Katze heißt Mimi.", "notiz.txt", "text/plain")),
    ingestDeps,
  );
  notizId = ((await notiz.json()) as { id: string }).id;
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe("retrieve()", () => {
  it("findet die Kaution auf Seite 2 und liefert Titel, Seite und Ähnlichkeit", async () => {
    const chunks = await retrieve("Wie hoch ist die Kaution insgesamt?", [vertragId, notizId], deps);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(5);
    const [best] = chunks;
    expect(best?.page).toBe(2);
    expect(best?.documentTitle).toBe("muster-mietvertrag");
    expect(best?.content).toContain("3.450 Euro");
    expect(best?.vectorSimilarity).toBeGreaterThan(0);
    expect(best?.vectorSimilarity).toBeLessThanOrEqual(1);
  });

  it("sucht nur in den ausgewählten Dokumenten", async () => {
    const chunks = await retrieve("Wie hoch ist die Kaution?", [notizId], deps);
    expect(chunks.every((chunk) => chunk.documentId === notizId)).toBe(true);
  });

  it("sucht bei leerer Auswahl gar nicht, statt alle Dokumente zu durchsuchen", async () => {
    const embed = vi.fn(stubEmbed);
    const chunks = await retrieve("Wie hoch ist die Kaution?", [], { db, embed });
    expect(chunks).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it("kennt die beste Ähnlichkeit aller Kandidaten, auch bei kleinem Limit", async () => {
    const question = "Wie hoch ist die Kaution insgesamt?";
    const wide = await retrieve(question, [vertragId, notizId], deps, { limit: 40 });
    const best = Math.max(...wide.map((chunk) => chunk.vectorSimilarity ?? 0));
    const [only] = await retrieve(question, [vertragId, notizId], deps, { limit: 1 });
    expect(only?.bestVectorSimilarity).toBeCloseTo(best, 6);
  });

  it("liefert für eine Frage ohne gemeinsame Wörter nur geringe Ähnlichkeit", async () => {
    const chunks = await retrieve("Quantenchromodynamik Gluonen", [vertragId], deps);
    const best = Math.max(0, ...chunks.map((chunk) => chunk.vectorSimilarity ?? 0));
    expect(best).toBeLessThan(0.25);
  });
});
