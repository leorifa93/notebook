import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

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
