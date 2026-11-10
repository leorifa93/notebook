import type { Queryable } from "@/lib/db";
import { toSqlVector } from "@/lib/embeddings";

/**
 * Hybrid-Suche: Vektorsuche + Volltextsuche, dann Fusion per Reciprocal Rank
 * Fusion (RRF).
 *
 * Warum hybrid: Embeddings finden Bedeutung ("Kündigungsfrist" ~ "Vertrag
 * endet"), verfehlen aber exakte Zeichenketten — Paragrafen, Produktnamen,
 * Zahlen, Aktenzeichen. Die Volltextsuche mit deutschem Stemming ist genau
 * dafür der Gegenpol. RRF braucht keine Score-Kalibrierung: beide Ranglisten
 * werden nur über ihre Position addiert, das ist robust und erklärbar.
 */

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  page: number | null;
  chunkIndex: number;
  content: string;
  /** RRF-Score, höher ist besser. Nur zur Sortierung, keine Prozentangabe. */
  score: number;
  /** Rang in der jeweiligen Einzelliste, für Debugging und das Eval. */
  vectorRank: number | null;
  textRank: number | null;
  /**
   * Kosinus-Ähnlichkeit zur Frage (1 = gleich), `null` bei reinen
   * Volltexttreffern. Anders als der RRF-Score ist sie absolut und taugt
   * deshalb als Schwelle für die Absage im Chat.
   */
  vectorSimilarity: number | null;
}

export interface RetrievalOptions {
  /** Wie viele Kandidaten je Liste geholt werden, bevor fusioniert wird. */
  candidatesPerList?: number;
  /** Wie viele Chunks am Ende zurückkommen (nach Rerank). */
  limit?: number;
}

/**
 * Datenbank und Embedding kommen von außen, wie beim Ingest: Produktion
 * verdrahtet Supabase und OpenAI, die Tests PGlite und Stub-Vektoren.
 */
export interface RetrievalDeps {
  db: Queryable;
  embed: (texts: readonly string[]) => Promise<number[][]>;
}

const DEFAULT_CANDIDATES = 20;
const DEFAULT_LIMIT = 5;
/** RRF-Dämpfung; 60 ist der Wert aus dem Paper und ein guter Default. */
const RRF_K = 60;

interface CandidateRow {
  chunk_id: string;
  document_id: string;
  document_title: string;
  page: number | null;
  chunk_index: number;
  content: string;
  vector_rank: number | string | null;
  text_rank: number | string | null;
  vector_similarity: number | string | null;
  rrf_score: number | string;
}

/**
 * Baut aus der Frage eine ODER-verknüpfte tsquery.
 *
 * `websearch_to_tsquery` verknüpft alle Wörter mit UND
 * ("Wie hoch ist die Kaution?" -> 'hoch' & 'kaution'). Eine natürliche Frage
 * trifft damit fast nie ein Dokument, weil irgendein Füllwort fehlt. Deshalb
 * `plainto_tsquery` (entfernt Stoppwörter) und dann `&` durch `|` ersetzen.
 *
 * Der Preis: Ein Chunk, der nur ein häufiges Wort enthält, ist ebenfalls
 * Kandidat. Das ist verkraftbar, weil `ts_rank_cd` Chunks mit mehr Treffern
 * nach oben sortiert und wir nur die Top-N in die Fusion geben.
 *
 * `NULLIF(..., '')` fängt Fragen ab, die nur aus Stoppwörtern bestehen —
 * sonst wäre die tsquery ein Syntaxfehler.
 */
/**
 * Führt beide Suchen in *einer* Abfrage aus.
 *
 * Zwei getrennte Queries wären einfacher zu lesen, aber dann müsste die
 * Fusion in TypeScript passieren. Ein CTE mit `FULL OUTER JOIN` auf die
 * Chunk-ID macht genau das, was RRF beschreibt, in einem Round-Trip.
 *
 * Exportiert, damit tests/unit/ingest.test.ts genau dieses SQL gegen PGlite
 * ausführt, statt eine Kopie zu prüfen.
 */
export const HYBRID_SQL = `
WITH text_query AS (
  -- ODER-verknüpfte tsquery, siehe Kommentar oben. Absichtlich inline statt
  -- als JS-Interpolation: so lässt sich HYBRID_SQL unverändert in psql
  -- einfügen und mit EXPLAIN prüfen.
  SELECT NULLIF(
           replace(plainto_tsquery('german', $4)::text, '&', '|'),
           ''
         )::tsquery AS q
),
vector_hits AS (
  SELECT
    c.id AS chunk_id,
    ROW_NUMBER() OVER (ORDER BY c.embedding <=> $1::vector) AS rank,
    1 - (c.embedding <=> $1::vector) AS similarity
  FROM chunks c
  WHERE c.embedding IS NOT NULL
    AND c.document_id = ANY($3::uuid[])
  ORDER BY c.embedding <=> $1::vector
  LIMIT $2
),
text_hits AS (
  SELECT
    c.id AS chunk_id,
    ROW_NUMBER() OVER (
      ORDER BY ts_rank_cd(to_tsvector('german', c.content), q.q) DESC
    ) AS rank
  FROM chunks c, text_query q
  WHERE q.q IS NOT NULL
    AND to_tsvector('german', c.content) @@ q.q
    AND c.document_id = ANY($3::uuid[])
  ORDER BY ts_rank_cd(to_tsvector('german', c.content), q.q) DESC
  LIMIT $2
),
fused AS (
  SELECT
    COALESCE(v.chunk_id, t.chunk_id) AS chunk_id,
    v.rank AS vector_rank,
    t.rank AS text_rank,
    v.similarity AS vector_similarity,
    COALESCE(1.0 / ($5::float + v.rank), 0) + COALESCE(1.0 / ($5::float + t.rank), 0) AS rrf_score
  FROM vector_hits v
  FULL OUTER JOIN text_hits t ON v.chunk_id = t.chunk_id
)
SELECT
  f.chunk_id::text        AS chunk_id,
  c.document_id::text     AS document_id,
  d.title                 AS document_title,
  c.page                  AS page,
  c.chunk_index           AS chunk_index,
  c.content               AS content,
  f.vector_rank           AS vector_rank,
  f.text_rank             AS text_rank,
  f.vector_similarity     AS vector_similarity,
  f.rrf_score             AS rrf_score
FROM fused f
JOIN chunks c ON c.id = f.chunk_id
JOIN documents d ON d.id = c.document_id
ORDER BY f.rrf_score DESC
LIMIT $6
`;

/**
 * Holt Kandidaten für eine Frage aus den angegebenen Dokumenten.
 *
 * `documentIds` ist Pflicht: Eine leere Auswahl heißt „keine Quelle“, nicht
 * „alle Quellen“. Früher wurde aus `[]` ein `NULL` und die Suche lief über
 * alle Dokumente, auch abgewählte. Jetzt gibt es dann weder Embedding noch
 * Abfrage, sondern eine leere Liste.
 */
export async function retrieve(
  question: string,
  documentIds: readonly string[],
  deps: RetrievalDeps,
  options: RetrievalOptions = {},
): Promise<RetrievedChunk[]> {
  const candidates = options.candidatesPerList ?? DEFAULT_CANDIDATES;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const trimmed = question.trim();
  if (trimmed === "" || documentIds.length === 0) return [];

  const [embedding] = await deps.embed([trimmed]);
  if (!embedding) throw new Error("Embedding für die Suchanfrage fehlgeschlagen.");

  const { rows } = await deps.db.query<CandidateRow>(HYBRID_SQL, [
    toSqlVector(embedding),
    candidates,
    [...documentIds],
    trimmed,
    RRF_K,
    limit,
  ]);

  return rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    page: row.page,
    chunkIndex: row.chunk_index,
    content: row.content,
    score: Number(row.rrf_score),
    vectorRank: row.vector_rank === null ? null : Number(row.vector_rank),
    textRank: row.text_rank === null ? null : Number(row.text_rank),
    vectorSimilarity: row.vector_similarity === null ? null : Number(row.vector_similarity),
  }));
}

/**
 * Optionaler zweiter Schritt: Rerank der Kandidaten.
 *
 * Die Fusion liefert bereits eine brauchbare Reihenfolge. Ein echtes
 * Cross-Encoder-Rerank (z. B. Cohere) kostet einen weiteren Dienst und eine
 * weitere Fehlerquelle in der Live-Demo. Deshalb ist hier nur der Platz
 * vorgesehen.
 *
 * TODO(Schritt 4): Anhand des Evals entscheiden, ob Rerank kommt, und im
 * README begründen. Aktuell identisch mit `retrieve`.
 */
export async function retrieveAndRerank(
  question: string,
  documentIds: readonly string[],
  deps: RetrievalDeps,
  options: RetrievalOptions = {},
): Promise<RetrievedChunk[]> {
  return retrieve(question, documentIds, deps, options);
}
