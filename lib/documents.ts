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

  return db.transaction(async (tx) => {
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
}

async function insertDocumentRow(tx: Queryable, document: NewDocument): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO documents (notebook_id, title, source_type, page_count, mime_type, file_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text AS id`,
    [
      document.notebookId,
      document.title,
      document.sourceType,
      document.pageCount,
      document.mimeType,
      document.fileBytes,
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
