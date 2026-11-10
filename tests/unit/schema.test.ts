import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { DEFAULT_NOTEBOOK_ID, DEFAULT_NOTEBOOK_TITLE } from "@/lib/notebooks";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite as PGliteClass } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { createTestDatabase, readSchema } from "../helpers/pglite";

const MIGRATION_PATH = fileURLToPath(
  new URL("../../db/migrations/2026-11-10-notebook-summaries.sql", import.meta.url),
);

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
       WHERE relname IN ('notebooks', 'documents', 'chunks', 'rate_limit_events', 'notebook_summaries')
       ORDER BY relname`,
    );
    expect(rows).toEqual([
      { relname: "chunks", relrowsecurity: true },
      { relname: "documents", relrowsecurity: true },
      { relname: "notebook_summaries", relrowsecurity: true },
      { relname: "notebooks", relrowsecurity: true },
      { relname: "rate_limit_events", relrowsecurity: true },
    ]);
  });
});

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

async function summaryColumns(target: PGlite): Promise<ColumnRow[]> {
  const { rows } = await target.query<ColumnRow>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name = 'notebook_summaries'
     ORDER BY ordinal_position`,
  );
  return rows;
}

describe("notebook_summaries", () => {
  it("hat eine Zeile pro Notebook und verschwindet mit dem Notebook", async () => {
    const notebook = await db.query<{ id: string }>(
      "INSERT INTO notebooks (title) VALUES ('Wegwerf') RETURNING id::text AS id",
    );
    const id = notebook.rows[0]?.id;
    const insert = `INSERT INTO notebook_summaries (notebook_id, sources_key, summary, model)
                    VALUES ($1, 'k', 'Text [1]', 'gpt-4o-mini')`;
    await db.query(insert, [id]);
    await expect(db.query(insert, [id])).rejects.toThrow(/duplicate key/);

    await db.query("DELETE FROM notebooks WHERE id = $1", [id]);
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notebook_summaries WHERE notebook_id = $1",
      [id],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("Migration legt auf einer Datenbank ohne die Tabelle dieselbe Tabelle an wie schema.sql", async () => {
    // Stand vor diesem Schritt: Schema eingespielt, Tabelle fehlt.
    const old = await PGliteClass.create({ extensions: { vector } });
    try {
      await old.exec(await readSchema());
      await old.exec("DROP TABLE notebook_summaries;");

      const migration = await readFile(MIGRATION_PATH, "utf8");
      await old.exec(migration);
      // Zweiter Lauf wirft nicht (Leonardo führt sie evtl. doppelt aus).
      await old.exec(migration);

      expect(await summaryColumns(old)).toEqual(await summaryColumns(db));
      const rls = await old.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE relname = 'notebook_summaries'",
      );
      expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    } finally {
      await old.close();
    }
  }, 30_000);
});
