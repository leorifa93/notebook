import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { DEFAULT_NOTEBOOK_ID, DEFAULT_NOTEBOOK_TITLE } from "@/lib/notebooks";

import { createTestDatabase, readSchema } from "../helpers/pglite";

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe("db/schema.sql gegen PGlite", () => {
  it("legt Tabellen und Indizes an", async () => {
    const { rows } = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
    );
    const names = rows.map((row) => row.indexname);
    expect(names).toContain("chunks_embedding_hnsw_idx");
    expect(names).toContain("chunks_content_fts_idx");
  });

  it("ist idempotent: ein zweiter Lauf wirft nicht", async () => {
    await expect(db.exec(await readSchema())).resolves.toBeDefined();
  });
});

describe("Notebook-Ebene", () => {
  it("legt das Default-Notebook mit der ID aus lib/notebooks.ts an", async () => {
    const { rows } = await db.query<{ id: string; title: string }>(
      "SELECT id::text AS id, title FROM notebooks WHERE id = $1",
      [DEFAULT_NOTEBOOK_ID],
    );
    expect(rows).toEqual([{ id: DEFAULT_NOTEBOOK_ID, title: DEFAULT_NOTEBOOK_TITLE }]);
  });
});

describe("Row Level Security", () => {
  it("ist auf allen Tabellen aktiv, damit die Supabase-REST-API nichts sieht", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname IN ('notebooks', 'documents', 'chunks', 'rate_limit_events')
       ORDER BY relname`,
    );
    expect(rows).toEqual([
      { relname: "chunks", relrowsecurity: true },
      { relname: "documents", relrowsecurity: true },
      { relname: "notebooks", relrowsecurity: true },
      { relname: "rate_limit_events", relrowsecurity: true },
    ]);
  });
});
