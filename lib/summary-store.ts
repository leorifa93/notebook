import { createHash } from "node:crypto";

import type { Queryable } from "@/lib/db";
import type { CitableChunk, Citation } from "@/lib/prompt";
import type { SummaryDocumentChunks, SummaryView } from "@/lib/summary";

/**
 * Quellenstand und Cache der Zusammenfassung in `notebook_summaries`.
 *
 * Wie lib/documents.ts bekommt jede Funktion den Executor übergeben; die
 * Tests führen dasselbe SQL gegen PGlite aus.
 */

/**
 * Schlüssel für den Quellenstand: SHA-256 über die sortierten
 * `content_sha256` aller Dokumente. Sortiert, damit die Reihenfolge der
 * Abfrage keine Rolle spielt; ein Upload oder Löschen ändert ihn.
 */
export function sourcesKey(contentHashes: readonly string[]): string {
  return createHash("sha256").update([...contentHashes].sort().join("\n"), "utf8").digest("hex");
}

/** `null`, wenn das Notebook keine Quellen hat. */
export async function loadSourcesKey(db: Queryable, notebookId: string): Promise<string | null> {
  // Zeilen vor Schritt 2 haben keinen Hash; ihre ID hält den Schlüssel
  // trotzdem eindeutig, sodass auch ihr Löschen den Cache ungültig macht.
  const { rows } = await db.query<{ hash: string }>(
    `SELECT coalesce(content_sha256, 'id:' || id::text) AS hash
     FROM documents WHERE notebook_id = $1`,
    [notebookId],
  );
  if (rows.length === 0) return null;
  return sourcesKey(rows.map((row) => row.hash));
}

export interface CachedSummary extends SummaryView {
  sourcesKey: string;
}

interface CachedSummaryRow {
  sources_key: string;
  summary: string;
  citations: unknown;
  questions: unknown;
  created_at: Date | string;
}

export async function getCachedSummary(
  db: Queryable,
  notebookId: string,
): Promise<CachedSummary | null> {
  const { rows } = await db.query<CachedSummaryRow>(
    `SELECT sources_key, summary, citations, questions, created_at
     FROM notebook_summaries WHERE notebook_id = $1`,
    [notebookId],
  );
  const row = rows[0];
  if (!row) return null;
  // Die Zeile schreibt nur saveSummary(); die Prüfung fängt eine von Hand
  // geänderte Zeile ab, statt das UI an `undefined.map` scheitern zu lassen.
  if (!Array.isArray(row.citations) || !Array.isArray(row.questions)) return null;
  return {
    sourcesKey: row.sources_key,
    text: row.summary,
    citations: row.citations as Citation[],
    questions: row.questions.filter((question): question is string => typeof question === "string"),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Schreibt oder ersetzt die Zusammenfassung des Notebooks. Upsert auf den
 * Primärschlüssel: Zwei gleichzeitige Erzeugungen enden in einer Zeile,
 * die letzte gewinnt, ohne Unique-Fehler.
 */
export async function saveSummary(
  db: Queryable,
  notebookId: string,
  key: string,
  view: Omit<SummaryView, "createdAt">,
  model: string,
): Promise<void> {
  await db.query(
    `INSERT INTO notebook_summaries
       (notebook_id, sources_key, summary, citations, questions, model)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (notebook_id) DO UPDATE SET
       sources_key = EXCLUDED.sources_key,
       summary     = EXCLUDED.summary,
       citations   = EXCLUDED.citations,
       questions   = EXCLUDED.questions,
       model       = EXCLUDED.model,
       created_at  = now()`,
    [
      notebookId,
      key,
      view.text,
      JSON.stringify(view.citations),
      JSON.stringify(view.questions),
      model,
    ],
  );
}

interface ChunkRefRow {
  document_id: string;
  chunk_id: string;
  token_count: number;
}

/**
 * Alle Chunks des Notebooks ohne Inhalt, nur für die Auswahl: Ein großes
 * PDF soll nicht komplett durch den Pooler, wenn zwölf Chunks gebraucht
 * werden. Älteste Quelle zuerst, damit die Nummern stabil bleiben.
 */
export async function loadSummaryChunkRefs(
  db: Queryable,
  notebookId: string,
): Promise<SummaryDocumentChunks[]> {
  const { rows } = await db.query<ChunkRefRow>(
    `SELECT c.document_id::text AS document_id, c.id::text AS chunk_id, c.token_count
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE d.notebook_id = $1
     ORDER BY d.created_at, d.id, c.chunk_index`,
    [notebookId],
  );
  const documents: Array<{ documentId: string; chunks: Array<{ chunkId: string; tokenCount: number }> }> = [];
  for (const row of rows) {
    let current = documents.at(-1);
    if (current?.documentId !== row.document_id) {
      current = { documentId: row.document_id, chunks: [] };
      documents.push(current);
    }
    current.chunks.push({ chunkId: row.chunk_id, tokenCount: Number(row.token_count) });
  }
  return documents;
}

interface ChunkRow {
  chunk_id: string;
  document_id: string;
  document_title: string;
  page: number | null;
  content: string;
}

/** Inhalt der ausgewählten Chunks, in Dokument- und Positionsreihenfolge. */
export async function loadChunksByIds(
  db: Queryable,
  notebookId: string,
  chunkIds: readonly string[],
): Promise<CitableChunk[]> {
  if (chunkIds.length === 0) return [];
  const { rows } = await db.query<ChunkRow>(
    `SELECT c.id::text AS chunk_id, c.document_id::text AS document_id,
            d.title AS document_title, c.page, c.content
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE d.notebook_id = $1 AND c.id = ANY($2::uuid[])
     ORDER BY d.created_at, d.id, c.chunk_index`,
    [notebookId, [...chunkIds]],
  );
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    page: row.page === null ? null : Number(row.page),
    content: row.content,
  }));
}
