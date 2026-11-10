import type { Chunk } from "@/lib/chunk";
import type { Database, Queryable } from "@/lib/db";
import { toSqlVector } from "@/lib/embeddings";
import type { SourceType } from "@/lib/ingest";

/**
 * Dokumente schreiben, listen und löschen.
 *
 * Jede Funktion bekommt den Executor übergeben (siehe `Database` in
 * lib/db.ts), statt `pg` selbst zu importieren. Das SQL bleibt hier lesbar
 * beieinander; die Tests führen es unverändert gegen PGlite aus.
 */

export interface NewDocument {
  notebookId: string;
  title: string;
  sourceType: SourceType;
  mimeType: string;
  pageCount: number;
  fileBytes: Uint8Array;
  contentSha256: string;
}

/** Der eindeutige Index auf (notebook_id, content_sha256) hat gegriffen. */
export class DuplicateDocumentError extends Error {
  constructor() {
    super("Dokument mit gleichem Inhalt existiert bereits in diesem Notebook.");
    this.name = "DuplicateDocumentError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export interface StoredDocument {
  id: string;
  title: string;
  sourceType: SourceType;
  pageCount: number;
  chunkCount: number;
}

/**
 * Dokument, Originaldatei und alle Chunks in *einer* Transaktion.
 *
 * Die Embeddings kommen fertig herein: Der OpenAI-Aufruf dauert Sekunden und
 * soll keine Transaktion offen halten. Schlägt ein Insert fehl, rollt alles
 * zurück, und es bleibt kein Dokument ohne Chunks stehen.
 */
export async function insertDocumentWithChunks(
  db: Database,
  document: NewDocument,
  chunks: readonly Chunk[],
  embeddings: readonly (readonly number[])[],
): Promise<StoredDocument> {
  if (chunks.length === 0) {
    throw new Error("Ein Dokument ohne Chunks wird nicht gespeichert.");
  }
  if (chunks.length !== embeddings.length) {
    throw new Error(
      `Anzahl Embeddings (${embeddings.length}) passt nicht zu Anzahl Chunks (${chunks.length}).`,
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const id = await insertDocumentRow(tx, document);
      await insertChunkRows(tx, id, chunks, embeddings);
      return {
        id,
        title: document.title,
        sourceType: document.sourceType,
        pageCount: document.pageCount,
        chunkCount: chunks.length,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateDocumentError();
    throw error;
  }
}

/** Gleiche Datei im selben Notebook, falls vorhanden. */
export async function findDocumentByHash(
  db: Queryable,
  notebookId: string,
  contentSha256: string,
): Promise<{ id: string; title: string } | null> {
  const { rows } = await db.query<{ id: string; title: string }>(
    `SELECT id::text AS id, title FROM documents
     WHERE notebook_id = $1 AND content_sha256 = $2`,
    [notebookId, contentSha256],
  );
  return rows[0] ?? null;
}

async function insertDocumentRow(tx: Queryable, document: NewDocument): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO documents
       (notebook_id, title, source_type, page_count, mime_type, file_bytes, content_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id::text AS id`,
    [
      document.notebookId,
      document.title,
      document.sourceType,
      document.pageCount,
      document.mimeType,
      document.fileBytes,
      document.contentSha256,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("INSERT INTO documents lieferte keine ID.");
  return row.id;
}

/**
 * Alle Chunks in einem Statement über `unnest`: ein Round-Trip statt einer
 * Schleife mit hunderten Inserts über den Pooler. Vektoren gehen als
 * pgvector-Literal (`toSqlVector`) und werden in SQL gecastet.
 */
async function insertChunkRows(
  tx: Queryable,
  documentId: string,
  chunks: readonly Chunk[],
  embeddings: readonly (readonly number[])[],
): Promise<void> {
  await tx.query(
    `INSERT INTO chunks (document_id, page, chunk_index, content, token_count, embedding)
     SELECT $1::uuid, t.page, t.chunk_index, t.content, t.token_count, t.embedding::vector
     FROM unnest($2::int[], $3::int[], $4::text[], $5::int[], $6::text[])
       AS t(page, chunk_index, content, token_count, embedding)`,
    [
      documentId,
      chunks.map((chunk) => chunk.page),
      chunks.map((chunk) => chunk.chunkIndex),
      chunks.map((chunk) => chunk.content),
      chunks.map((chunk) => chunk.tokenCount),
      embeddings.map((embedding) => toSqlVector(embedding)),
    ],
  );
}

export interface DocumentSummary {
  id: string;
  title: string;
  sourceType: SourceType;
  pageCount: number;
  chunkCount: number;
  sizeBytes: number;
  /** ISO-8601, damit Server und Client dasselbe Format sehen. */
  createdAt: string;
}

export interface NotebookSummary {
  id: string;
  title: string;
}

interface DocumentSummaryRow {
  id: string;
  title: string;
  source_type: SourceType;
  page_count: number;
  chunk_count: number;
  size_bytes: number | null;
  created_at: Date | string;
}

/** Notebook-Kopf für die Sidebar; `null`, wenn es die ID nicht gibt. */
export async function getNotebook(
  db: Queryable,
  notebookId: string,
): Promise<NotebookSummary | null> {
  const { rows } = await db.query<NotebookSummary>(
    "SELECT id::text AS id, title FROM notebooks WHERE id = $1",
    [notebookId],
  );
  return rows[0] ?? null;
}

/**
 * Quellen eines Notebooks, neueste zuerst. Die Datei selbst wird nicht
 * gelesen, nur ihre Größe: Die Liste soll nicht Megabytes durch den Pooler
 * ziehen, um Titel anzuzeigen.
 */
export async function listDocuments(
  db: Queryable,
  notebookId: string,
): Promise<DocumentSummary[]> {
  const { rows } = await db.query<DocumentSummaryRow>(
    `SELECT
       d.id::text                     AS id,
       d.title                        AS title,
       d.source_type                  AS source_type,
       d.page_count                   AS page_count,
       (SELECT count(*)::int FROM chunks c WHERE c.document_id = d.id) AS chunk_count,
       octet_length(d.file_bytes)     AS size_bytes,
       d.created_at                   AS created_at
     FROM documents d
     WHERE d.notebook_id = $1
     ORDER BY d.created_at DESC, d.id`,
    [notebookId],
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    pageCount: Number(row.page_count),
    chunkCount: Number(row.chunk_count),
    sizeBytes: row.size_bytes === null ? 0 : Number(row.size_bytes),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/**
 * Löscht eine Quelle samt Chunks (ON DELETE CASCADE in db/schema.sql).
 * Eingeschränkt aufs Notebook, damit eine ID aus einem anderen Notebook
 * hier nichts löscht. `false`, wenn es nichts zu löschen gab.
 */
export async function deleteDocument(
  db: Queryable,
  notebookId: string,
  documentId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    "DELETE FROM documents WHERE id = $1 AND notebook_id = $2 RETURNING id::text AS id",
    [documentId, notebookId],
  );
  return rows.length > 0;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Vorab prüfen, sonst wirft Postgres bei `$1::uuid` einen 500er statt 400. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
