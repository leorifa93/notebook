import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

/**
 * Echtes Postgres im Testprozess.
 *
 * Der Entwicklungsrechner erreicht keine Postgres-Ports, und die CI soll ohne
 * Secrets laufen. PGlite ist Postgres als WASM, mit offizieller
 * pgvector-Extension — damit laufen HNSW, `<=>`, deutsche Volltextsuche und
 * `ON DELETE CASCADE` wirklich, statt gegen einen Mock zu testen.
 *
 * Geladen wird genau `db/schema.sql`, dieselbe Datei, die Leonardo im
 * Supabase-SQL-Editor ausführt. Ein Schemafehler fällt damit hier zuerst auf.
 */

const SCHEMA_PATH = fileURLToPath(new URL("../../db/schema.sql", import.meta.url));

export async function readSchema(): Promise<string> {
  return readFile(SCHEMA_PATH, "utf8");
}

/** Frische Datenbank mit eingespieltem Schema. Pro Testdatei einmal erzeugen. */
export async function createTestDatabase(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(await readSchema());
  return db;
}
