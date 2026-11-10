import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { handleIngest } from "@/app/api/ingest/handler";
import { HYBRID_SQL, retrieve, type RetrievalDeps } from "@/lib/retrieval";

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

/**
 * F1 aus dem frischen Review: Kleine Quelle angehakt, große daneben nicht.
 *
 * Nutzt der Planer den HNSW-Index, filtert pgvector `document_id` erst nach
 * dem Index-Scan. Ohne iterativen Scan liefert der Index nur die
 * `hnsw.ef_search` (40) nächsten Chunks; liegen die alle in der großen,
 * abgewählten Quelle, bleibt die Vektorsuche leer und der Chat sagt still ab.
 *
 * Bei so wenigen Zeilen würde PGlite sonst sequenziell scannen oder den
 * B-Baum auf `document_id` nehmen. `enable_sort = off` lässt dem Planer nur
 * den HNSW-Index für `ORDER BY embedding <=> …`, also genau den Pfad, den
 * Supabase bei vielen Chunks wählt. Der Test ist ohne den Fix rot.
 */
describe("retrieve() über den HNSW-Index (F1)", () => {
  let hnswDb: PGlite;
  let smallId: string;
  const BIG_CHUNKS = 300;
  const DIMENSIONS = 1536;

  /**
   * Einheitsvektor mit Anteil `alongQuery` auf Achse 0, einer eigenen Achse
   * und etwas deterministischem Rauschen. Ohne Rauschen (lauter exakt
   * orthogonale Restachsen) baut HNSW einen entarteten Graphen, in dem auch
   * der iterative Scan den Chunk nicht erreicht; echte Embeddings sind nie so.
   */
  function unitVector(alongQuery: number, seed: number): string {
    const values = new Array<number>(DIMENSIONS).fill(0);
    let state = seed;
    for (let index = 1; index < DIMENSIONS; index++) {
      state = (state * 9301 + 49297) % 233280;
      values[index] = (state / 233280 - 0.5) * 0.02;
    }
    values[0] = alongQuery;
    const ownAxis = 1000 + (seed % 500);
    values[ownAxis] = (values[ownAxis] ?? 0) + Math.sqrt(1 - alongQuery * alongQuery);
    const norm = Math.hypot(...values);
    return `[${values.map((value) => value / norm).join(",")}]`;
  }

  async function insertDocument(title: string): Promise<string> {
    const { rows } = await hnswDb.query<{ id: string }>(
      "INSERT INTO documents (title, source_type) VALUES ($1, 'text') RETURNING id::text AS id",
      [title],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("Dokument nicht angelegt");
    return id;
  }

  async function insertChunk(documentId: string, index: number, embedding: string): Promise<void> {
    await hnswDb.query(
      `INSERT INTO chunks (document_id, chunk_index, content, token_count, embedding)
       VALUES ($1, $2, $3, 1, $4::vector)`,
      [documentId, index, `Abschnitt ${index}`, embedding],
    );
  }

  beforeAll(async () => {
    hnswDb = await createTestDatabase();
    const bigId = await insertDocument("gross");
    smallId = await insertDocument("klein");
    // Alle Chunks der großen Quelle liegen näher an der Frage als der der kleinen.
    for (let index = 0; index < BIG_CHUNKS; index++) {
      await insertChunk(bigId, index, unitVector(0.9, 1 + index));
    }
    await insertChunk(smallId, 0, unitVector(0.4, 7777));
    await hnswDb.exec("ANALYZE; SET enable_sort = off;");
  }, 60_000);

  afterAll(async () => {
    await hnswDb.close();
  });

  const queryEmbed = async (texts: readonly string[]): Promise<number[][]> =>
    texts.map(() => [1, ...new Array<number>(DIMENSIONS - 1).fill(0)]);

  it("nutzt in diesem Aufbau wirklich den HNSW-Index", async () => {
    const { rows } = await hnswDb.query<{ "QUERY PLAN": string }>(`EXPLAIN ${HYBRID_SQL}`, [
      unitVector(1, 1),
      20,
      [smallId],
      "Quantenchromodynamik",
      60,
      5,
    ]);
    expect(rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
      "chunks_embedding_hnsw_idx",
    );
  });

  it("findet den Chunk der kleinen Quelle, obwohl die große näher liegt", async () => {
    const chunks = await retrieve("Quantenchromodynamik", [smallId], {
      db: hnswDb,
      embed: queryEmbed,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.documentId).toBe(smallId);
    expect(chunks[0]?.vectorSimilarity).toBeGreaterThan(0.3);
  });

  it("setzt den iterativen Scan nur für die Suche, nicht für die Sitzung", async () => {
    await retrieve("Quantenchromodynamik", [smallId], { db: hnswDb, embed: queryEmbed });
    const { rows } = await hnswDb.query<{ value: string }>(
      "SELECT current_setting('hnsw.iterative_scan') AS value",
    );
    expect(rows[0]?.value).toBe("off");
  });
});
