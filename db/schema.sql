-- ============================================================================
-- Notebook – Datenbankschema
-- Supabase-Postgres mit pgvector. pgvector ist dort vorinstalliert; kein
-- eigenes Datenbank-Setup, kein Docker, keine zweite Abhängigkeit.
--
-- Ausführen:  psql "$DATABASE_URL" -f db/schema.sql
-- Mehrfach ausführbar (IF NOT EXISTS), damit Setup-Skripte idempotent sind.
-- ============================================================================

-- pgvector stellt den Typ `vector` und die Distanzoperatoren (<->, <=>, <#>)
-- bereit. Auf Managed-Postgres braucht das je nach Anbieter Superuser-Rechte;
-- bei Supabase ist es im SQL-Editor bereits freigeschaltet.
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- documents: ein hochgeladenes Dokument pro Zeile.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text        NOT NULL,
  -- 'pdf' | 'text' | 'markdown'. Bewusst text statt ENUM: ein neuer Typ soll
  -- keine Migration erfordern, die Validierung passiert in lib/pdf.ts.
  source_type text        NOT NULL,
  page_count  integer     NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE documents IS
  'Hochgeladene Quellen. Eine Zeile pro Datei.';
COMMENT ON COLUMN documents.source_type IS
  'pdf | text | markdown – validiert in detectSourceType() (lib/pdf.ts).';

-- ----------------------------------------------------------------------------
-- chunks: die eigentliche Sucheinheit.
--
-- Jeder Chunk kennt seine Seite. Das ist die Voraussetzung dafür, dass ein
-- Beleg im Chat wirklich auf die richtige PDF-Seite springt und nicht nur
-- "irgendwo im Dokument" landet.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE: eine gelöschte Quelle nimmt ihre Chunks mit. Ohne das
  -- würden verwaiste Chunks weiter in der Suche auftauchen und Antworten
  -- belegen, deren Dokument es nicht mehr gibt.
  document_id uuid    NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  -- 1-basiert wie im PDF-Viewer; NULL für Quellen ohne Seiten (Markdown).
  page        integer CHECK (page IS NULL OR page >= 1),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content     text    NOT NULL,
  -- Geschätzte Tokens (siehe lib/chunk.ts). Dient der Kostenkontrolle und
  -- dem Prompt-Budget, nicht der Suche.
  token_count integer NOT NULL CHECK (token_count >= 0),
  -- 1536 = Dimensionen von text-embedding-3-small. Ein anderes Modell mit
  -- anderer Dimension braucht ALTER TABLE ... TYPE vector(n) plus Re-Embedding.
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- Ein Dokument darf eine Position nicht doppelt belegen. Verhindert
  -- Doppel-Chunks, wenn ein Ingest versehentlich zweimal läuft.
  UNIQUE (document_id, chunk_index)
);

COMMENT ON TABLE chunks IS
  'Chunks mit Seitenzahl und Embedding. Sucheinheit für Vektor- und Volltextsuche.';
COMMENT ON COLUMN chunks.page IS
  'Seite im Originaldokument, 1-basiert. NULL bei seitenlosen Quellen.';

-- ----------------------------------------------------------------------------
-- Indexe
-- ----------------------------------------------------------------------------

-- HNSW auf der Vektorspalte mit Kosinus-Distanz.
--
-- Warum HNSW und nicht IVFFlat: HNSW lässt sich auf einer leeren Tabelle
-- anlegen (kein Trainingsschritt) und hat die bessere Speed-Recall-Kurve.
-- IVFFlat müsste nach dem Laden der Daten neu gebaut werden, sonst ist die
-- Recall schlecht — bei einem Testprojekt mit wechselnden Seed-Daten ein
-- unnötiges Risiko.
--
-- Warum Kosinus: OpenAI-Embeddings sind normalisiert, Kosinus und inneres
-- Produkt liefern fast dasselbe Ergebnis. Kosinus bleibt aber auch dann
-- korrekt, wenn später ein nicht-normalisiertes Modell dazukommt. Der
-- Operator in lib/retrieval.ts ist entsprechend `<=>`.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN auf dem deutschen Volltext-Index.
--
-- Das ist die zweite Hälfte der Hybrid-Suche: Sie findet exakte Zeichenketten
-- (Paragrafen, Produktnamen, Zahlen, Aktenzeichen), an denen Embeddings
-- systematisch vorbeilaufen. Die zweistellige Form
-- to_tsvector('german', content) ist immutable und damit indexierbar; die
-- einstellige Form hängt an der Server-Config und wäre es nicht.
--
-- Das Stemming ist deutsch, weil die Zielgruppe deutschsprachige Dokumente
-- hochlädt. Für englische Dokumente würde man eine zweite Spalte mit
-- 'english' pflegen.
CREATE INDEX IF NOT EXISTS chunks_content_fts_idx
  ON chunks USING gin (to_tsvector('german', content));

-- Fremdschlüssel-Index. Postgres legt für Foreign Keys keinen Index
-- automatisch an; ohne diesen wäre ON DELETE CASCADE ein Sequential Scan.
CREATE INDEX IF NOT EXISTS chunks_document_id_idx
  ON chunks (document_id);

-- Seitenabruf beim Zitat-Klick: "alle Chunks von Dokument X auf Seite N".
CREATE INDEX IF NOT EXISTS chunks_document_page_idx
  ON chunks (document_id, page);

-- Übersicht in der Seitenleiste, neueste zuerst.
CREATE INDEX IF NOT EXISTS documents_created_at_idx
  ON documents (created_at DESC);

-- ----------------------------------------------------------------------------
-- Hinweise für den Betrieb
-- ----------------------------------------------------------------------------
-- 1) Der HNSW-Index wird bei jedem Insert mitgeschrieben. Für den Bulk-Import
--    der Seed-Daten ist es schneller, ihn vorher zu droppen und danach neu zu
--    bauen. Bei den Datenmengen dieses Testprojekts ist das irrelevant.
-- 2) Ab ca. 100k Chunks lohnt `SET hnsw.ef_search = 100` pro Query, weil der
--    Default von 40 bei gefilterten Suchen zu wenige Treffer liefert.
-- 3) `ANALYZE chunks;` nach dem Seed, sonst schätzt der Planner die
--    Selektivität der Volltextsuche falsch.
