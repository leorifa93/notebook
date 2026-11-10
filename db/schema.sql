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
-- notebooks: Klammer um Quellen, wie in NotebookLM (Schritt 2).
--
-- Die Demo hat genau ein Notebook „Demo" mit fester ID; ein Umschalter ist
-- bewusst nicht gebaut. Die Ebene kommt trotzdem jetzt, weil sie später
-- nachzurüsten eine Migration auf bereits hochgeladenen Demo-Daten wäre.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notebooks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE notebooks IS
  'Notebooks. In der Demo nur das Default-Notebook „Demo".';

-- Feste ID, damit Code (lib/notebooks.ts) und Schema dieselbe Zeile meinen,
-- ohne beim Start nachzuschlagen. ON CONFLICT hält das Skript idempotent.
INSERT INTO notebooks (id, title)
VALUES ('00000000-0000-4000-8000-000000000001', 'Demo')
ON CONFLICT (id) DO NOTHING;

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

-- Originaldatei in derselben Zeile (Schritt 2). Der Seitensprung im Chat
-- (Schritt 3) braucht das Original. Als bytea statt Supabase Storage, damit
-- Datei, Dokument und Chunks in *einer* Transaktion landen und kein zweiter
-- Dienst mit eigenen Policies dazukommt. Bei wenigen Dateien unter 4 MB ist
-- das über TOAST unkritisch; produktiv gehörte das in einen Objektspeicher.
-- Nullable, weil ALTER TABLE ... ADD COLUMN auf bestehenden Zeilen laufen
-- muss; der Ingest setzt beide Spalten immer.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_bytes bytea;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime_type  text;

COMMENT ON COLUMN documents.file_bytes IS
  'Originaldatei, geschrieben in derselben Transaktion wie die Chunks.';

-- Jede Quelle gehört genau einem Notebook. Der DEFAULT hängt Dokumente, die
-- vor Schritt 2 angelegt wurden, beim erneuten Ausführen an „Demo"; der
-- Ingest setzt die Spalte trotzdem immer explizit. CASCADE: ein gelöschtes
-- Notebook nimmt Dokumente und (über chunks.document_id) deren Chunks mit.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS notebook_id uuid NOT NULL
    DEFAULT '00000000-0000-4000-8000-000000000001'
    REFERENCES notebooks (id) ON DELETE CASCADE;

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
-- rate_limit_events: ein Eintrag pro gezählter Anfrage (Schritt 2).
--
-- Die Demo ist bewusst ohne Login. Ohne Limit kann jeder den Embedding-Pfad
-- mit dem Demo-Key leerlaufen lassen. In Postgres statt Upstash o. ä.: kein
-- neuer Account, kein neuer Key, und die Tabelle ist in Supabase sichtbar.
-- Die Zählung (Fenster, Limit) steckt in lib/rate-limit.ts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip         text        NOT NULL,
  -- z. B. 'ingest'; Chat bekommt in Schritt 3 einen eigenen Schlüssel.
  endpoint   text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE rate_limit_events IS
  'Gezählte Anfragen pro IP und Endpoint für das Rate-Limit der offenen Demo.';

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

-- Quellenliste eines Notebooks, neueste zuerst; deckt auch den FK für CASCADE.
CREATE INDEX IF NOT EXISTS documents_notebook_created_idx
  ON documents (notebook_id, created_at DESC);

-- Zählen im Fenster: "Anfragen dieser IP an diesen Endpoint seit T".
CREATE INDEX IF NOT EXISTS rate_limit_events_lookup_idx
  ON rate_limit_events (endpoint, ip, created_at);

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
