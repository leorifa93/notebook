-- ============================================================================
-- Migration 2026-11-10: Cache für Zusammenfassung und Fragevorschläge
--
-- Für Datenbanken, auf denen db/schema.sql schon vor Schritt 3 (PR
-- „Zusammenfassung“) lief. Einmal im Supabase-Dashboard unter SQL Editor
-- ausführen. Mehrfach ausführbar: Ein zweiter Lauf ändert nichts.
--
-- Inhaltlich identisch mit dem Abschnitt `notebook_summaries` in
-- db/schema.sql; tests/unit/schema.test.ts prüft, dass beide dieselbe Tabelle
-- anlegen. Wer db/schema.sql komplett neu einspielt, braucht dieses Skript
-- nicht.
--
-- Fehlt die Tabelle, meldet GET /api/summary 503 („nicht vollständig
-- eingerichtet“); Quellen und Chat funktionieren weiter.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notebook_summaries (
  notebook_id uuid        PRIMARY KEY REFERENCES notebooks (id) ON DELETE CASCADE,
  sources_key text        NOT NULL,
  summary     text        NOT NULL,
  citations   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  questions   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  model       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE notebook_summaries IS
  'Zusammenfassung und Fragevorschläge je Notebook, gültig für sources_key.';
COMMENT ON COLUMN notebook_summaries.sources_key IS
  'SHA-256 über die sortierten content_sha256 der Dokumente (lib/summary.ts).';

-- Wie alle Tabellen: sperrt die Supabase-REST-API (anon-Key) aus. Die App
-- spricht als Tabellenbesitzer über `pg` und ist von RLS ausgenommen.
ALTER TABLE notebook_summaries ENABLE ROW LEVEL SECURITY;
