# Plan Schritt 2 — Ingest

Ziel für heute: nach diesem Schritt kann Leonardo ein PDF (oder Markdown/Text) hochladen, es landet vollständig in Supabase, die Sidebar zeigt echte Quellen, und ein Vercel-Preview ist anschließbar. Chat, Auto-Zusammenfassung und Fragevorschläge bleiben Schritt 3. Der Schnitt ist auf 1–2 Stunden Umsetzung ausgelegt.

Voraussetzung: Dieser Plan gilt erst nach Leonardos Freigabe. Danach setzt der Umsetzer ihn in kleinen Commits auf `feature/ingest` um. Kein Merge, kein Deployment durch eine Rolle.

---

## Entscheidungen

### 1. Einfacher Request-Response, kein NDJSON

Der Ingest antwortet erst, wenn die Transaktion steht: `{ id, title, sourceType, pageCount, chunkCount }`. Die UI zeigt einen ehrlichen Ladezustand („Datei wird gelesen, zerlegt und eingebettet…"), keine gefakte Stufenanzeige. Verworfene Alternative: NDJSON mit `validating|parsing|chunking|embedding|storing`. Das wäre dem Designer-Wunsch nach sichtbaren Pipeline-Stufen näher, verdoppelt aber den Client (Stream parsen, Abbruch, Fehler mitten im Lauf) — bei einem Seitenlimit und `text-embedding-3-small` ist ein typisches Demo-PDF in wenigen Sekunden fertig, der Gewinn für die Live-Demo ist gering.

### 2. Dateigröße 4 MB, höchstens 40 Seiten

`MAX_FILE_BYTES` sinkt von 20 MB auf 4 MB, dazu kommt ein Seitenlimit von 40. Vercel Serverless begrenzt den Request-Body auf etwa 4,5 MB; 20 MB wären auf dem Live-Deployment ein stiller 413 ohne unsere Fehlermeldung. 40 Seiten bleiben unter `maxDuration = 60` (Hobby-Maximum, steht schon in der Route) und im Budget des Test-Keys. `runtime = "nodejs"` bleibt, weil `pg` und `unpdf` keine Edge-Runtime vertragen.

### 3. PDF, Markdown und Text; Scans ablehnen

`detectSourceType()` akzeptiert die drei Typen schon. Markdown und Text werden als ein Dokument mit `page = null` geparst — das Schema erlaubt das bereits, und erfundene Seitenzahlen wären unehrlich. PDFs mit `probablyScanned === true` oder ohne extrahierbaren Text werden mit 422 abgelehnt, nicht leer indexiert. Office und Bilder bleiben 415.

### 4. Originaldatei als `bytea` in derselben Transaktion

`documents` bekommt `file_bytes bytea` und `mime_type text`. Der Seitensprung im Chat (Schritt 3) braucht das Original; ohne Speichern in Schritt 2 müsste die Datei später nachgereicht werden. Verworfene Alternative: Supabase Storage. Das wäre ein zweiter Dienst, eigene Policies und kein gemeinsames Commit mit den Chunks — bei wenigen Dateien unter 4 MB ist TOAST in Postgres ausreichend.

### 5. Rate-Limit für Ingest in diesem Schritt, in Postgres

Eine Tabelle `rate_limit_events (ip, endpoint, created_at)` plus Hilfsfunktion, Fenster 15 Minuten, Limit 8 Anfragen pro IP für `POST /api/ingest`. Die Demo ist bewusst ohne Login; nach diesem Schritt ist der teure Embedding-Pfad öffentlich, und 5 $ Guthaben sind schnell leergefragt. Chat nutzt dieselbe Hilfsfunktion, wird aber erst in Schritt 3 verdrahtet, weil die Route bis dahin 501 bleibt. Verworfene Alternative: ein externer Dienst (Upstash o. ä.) — neuer Account, neuer Key, widerspricht dem Stack. IP aus dem ersten Eintrag von `x-forwarded-for` (Vercel). Antwort 429, deutsch, ohne interne Details.

### 6. Tests gegen PGlite, Embeddings gestubbt, echte Fixture-PDFs

Der Entwicklungsrechner erreicht keine Postgres-Ports; CI soll weiter ohne Secrets laufen. Deshalb Dev-Dependencies `@electric-sql/pglite` und `@electric-sql/pglite-pgvector` (siehe Prüfung unten). Die Schreibfunktionen (Insert, Liste, Löschen, Rate-Limit) bekommen einen schmalen Query-Executor: Produktion verdrahtet `lib/db.ts` (`pg`), Tests den PGlite-Helper. `embedTexts` wird in den Tests durch deterministische, normalisierte 1536-Vektoren ersetzt. Parser-Tests laufen gegen echte Dateien unter `fixtures/`. Die 501-Erwartung in `tests/unit/api-validation.test.ts` für Ingest wird bewusst umgeschrieben; die Chat-501-Tests bleiben bis Schritt 3.

### 7. Option (Freigabe nötig): Notebooks als Ebene

Vorschlag: Tabelle `notebooks`, `documents.notebook_id … ON DELETE CASCADE`, ein Default-Notebook „Demo", Quellen in der Sidebar an- und abwählbar (die Chat-Route kennt `documentIds` schon). Aufwand etwa 30–45 Minuten für Schema, Filter und Checkboxen; ein Notebook-Umschalter ist nicht Teil des Vorschlags. Begründung: NotebookLM ist so aufgebaut, und `notebook_id` später nachzurüsten ist eine Migration auf bereits hochgeladenen Demo-Daten. Wenn Leonardo die Option abwählt, bleiben Dokumente global wie bisher — der Rest des Plans ändert sich nicht.

Auto-Zusammenfassung nach dem Upload und vorgeschlagene Fragen gehören zu Schritt 3. Hier nur erwähnt, damit sie nicht still in diesen Schnitt rutschen.

---

## Aufgaben / Commits

Geplante Reihenfolge nach Freigabe. Dieser Plan-Commit ist bereits erledigt.

1. `chore: PGlite und pgvector als Testdependencies` — Pakete plus Test-Helper, der `db/schema.sql` lädt.
2. `db: Dateiinhalt und Rate-Limit-Tabelle im Schema` — `file_bytes`, `mime_type`, `rate_limit_events`, idempotent (`ADD COLUMN IF NOT EXISTS`); falls Freigabe: in diesem oder einem eigenen Commit `notebooks` und `documents.notebook_id`.
3. `ingest: Datei validieren, parsen und Scans ablehnen` — 4 MB / 40 Seiten, PDF/Markdown/Text, klare 4xx, `parsePdf` bzw. Text-Parse.
4. `ingest: Chunks einbetten und in einer Transaktion speichern` — `embedTexts` → `withTransaction` (Dokument + Chunks + Datei), kein Dokument ohne Chunks.
5. `api: Dokumente listen und löschen` — `GET`/`DELETE /api/documents`, Cascade über das bestehende Schema.
6. `api: Rate-Limit pro IP für Ingest in Postgres` — Hilfsfunktion, 429 am Ingest-Endpoint.
7. `test: Parser an Fixture-PDFs und Ingest gegen PGlite` — Scan-Ablehnung, Transaktion, Cascade, 501-Test für Ingest anpassen, ein Hybrid-SQL-Rauchtest mit Stub-Vektoren.
8. `ui: Upload, Quellenzustände und Löschen in der Sidebar` — leer / lädt / Fehler / fertig; Quellen mit Titel, Typ, Seitenzahl; auf schmalem Viewport erreichbar (die Sidebar ist heute `hidden md:block`).
9. `docs: Seed-PDFs und README auf den Stand von Schritt 2` — Fixtures einchecken, Setup und ehrlichen Stand aktualisieren.

---

## Abnahmekriterien

- Ein gültiges PDF unter 4 MB und 40 Seiten ergibt 201 und erscheint in `GET /api/documents` mit Titel, Seitenzahl und Chunk-Anzahl; die Datei liegt als `bytea` in derselben Zeile.
- Markdown und `.txt` werden angenommen, `page` an ihren Chunks ist `null`. Ein Scan-PDF und eine Datei ohne Text liefern 422 auf Deutsch, ohne Zeile in `documents`.
- Dateien über 4 MB liefern 413, über 40 Seiten 413, unbekannte Typen 415, leerer oder kaputter Body 400 — jeweils deutsch, ohne Stacktrace.
- Bricht das Chunk-Insert oder das Embedding ab, bleibt kein Dokument ohne Chunks zurück (`withTransaction`).
- `DELETE /api/documents/:id` entfernt die Quelle und ihre Chunks (Cascade); die Sidebar aktualisiert sich.
- Die neunte Ingest-Anfrage derselben IP innerhalb von 15 Minuten liefert 429; Chat bleibt 501 und ohne Rate-Limit-Verdrahtung.
- `npm run typecheck`, `lint`, `test` und `build` sind grün, auch ohne `DATABASE_URL` und ohne `OPENAI_API_KEY`. Der alte Ingest-501-Test ist umgeschrieben, nicht still grün geblieben.
- Die Sidebar zeigt leer, lädt, Fehler und fertig; Upload und Quellenliste sind auf schmalem und breitem Fenster bedienbar.
- Kein Secret im Diff. Neue Pakete nur die beiden PGlite-Dev-Dependencies, im PR begründet.

---

## Nicht-Ziele (bewusst in diesem Schritt draußen)

- Chat-Streaming, Belegkarten, Sprung in die PDF-Seite (Schritt 3; die Datei wird nur gespeichert).
- Auto-Zusammenfassung und Fragevorschläge (Schritt 3).
- Authentifizierung, Audio/TTS, OCR, eigene Vektordatenbank, Wechsel des Embedding-Modells, Änderung von `lib/prompt.ts`.
- Deployment und Vercel-Projektverbindung (Leonardo, siehe unten).
- Eval-Runner (Schritt 4).
- Mehrere Notebooks umschalten, Teilen, Multi-User — auch dann nicht, wenn die Notebook-Option angenommen wird.

---

## PGlite-Prüfung (praktisch, 10.11.2026)

Gegen `@electric-sql/pglite@0.5.16` und `@electric-sql/pglite-pgvector@0.0.17` (Import: `vector` aus `@electric-sql/pglite-pgvector`, nicht mehr `@electric-sql/pglite/vector`):

- Postgres 18.6, pgvector 0.8.7, `gen_random_uuid()` vorhanden.
- `db/schema.sql` läuft idempotent durch, inklusive HNSW (`vector_cosine_ops`, m=16, ef_construction=64) und GIN auf `to_tsvector('german', content)`.
- Deutsche Volltextsuche ist vorhanden (`german` in `pg_ts_config`); Stemming und Stoppwörter greifen (`Kündigungsfristen` → `kundigungsfrist`). `EXPLAIN` nutzt `chunks_content_fts_idx`.
- `<=>` funktioniert; `EXPLAIN` zeigt `Index Scan using chunks_embedding_hnsw_idx`. Bei normalisierten Vektoren ist die Reihenfolge korrekt. Unnormalisierte, fast-null-Vektoren sind numerisch unbrauchbar — Stub-Embeddings deshalb wie das echte Modell normalisieren.
- `ON DELETE CASCADE` und `UNIQUE (document_id, chunk_index)` greifen.

Damit kann Schritt 2 die DB-Tests ohne erreichbares Supabase in der CI ausführen. Die Integration gegen das echte Projekt bleibt das Vercel-Preview.

---

## Neue Abhängigkeiten

Nur als `devDependencies`, Begründungspflicht laut `AGENTS.md`:

| Paket | Warum | Verworfene Alternative |
| --- | --- | --- |
| `@electric-sql/pglite` | echtes Postgres im Prozess, ohne Netz und ohne Secrets in der CI | Testcontainers / externes Postgres — auf diesem Rechner laufen Postgres-Ports ins Timeout, und CI würde einen Dienst brauchen |
| `@electric-sql/pglite-pgvector` | offizielle pgvector-Extension für PGlite 0.5; ohne sie fehlen Typ, HNSW und `<=>` | Schema in den Tests stutzen oder Vektorspalte weglassen — würde genau den Pfad unbelegt lassen, der in der Demo zählt |

Kein `pdf-lib` in der App: Fixture-PDFs einmal erzeugen und als Binärdateien unter `fixtures/` committen.

---

## Seed-PDFs

Vorschlag (Leonardo bestätigt unter Frage 2): zwei selbst verfasste, kurze deutsche PDFs unter `fixtures/`, Lizenz CC0, Zahlen und Seitenzahlen passend zu `docs/eval-plan.md`.

- `fixtures/muster-mietvertrag.pdf` — ca. 6 Seiten, Fließtext, Paragrafen, Miete 1.150 €, Kaution 3.450 €, Kündigungsfrist drei Monate. Hauptquelle für Demo und späteres Eval.
- `fixtures/scan-beispiel.pdf` — bildbasiert bzw. fast ohne Text, nur für den 422-Test, nicht für die Demo.

Die Demo startet leer; Leonardo lädt den Mietvertrag im Loom hoch. Kein Seed-Skript beim Deploy (das würde den OpenAI-Key in der CI brauchen). Ein zweites, amtliches Dokument (z. B. ein kurzes Werk von [gesetze-im-internet.de](https://www.gesetze-im-internet.de), urheberrechtsfrei als amtliches Werk) nur, wenn Leonardo das fürs Video will.

---

## Vercel-Preview (nur für Leonardo, nicht in diesem Chat)

Nach dem Umsetzungs-PR, nicht vorher:

1. GitHub-Repo in Vercel importieren bzw. das vorhandene Projekt verbinden. Preview-Deployments pro Branch/PR einschalten.
2. Environment Variables für Production **und** Preview: `DATABASE_URL` = Transaction-Pooler-URL (Port 6543, Benutzer `postgres.<projekt-ref>`, Host `*.pooler.supabase.com`), `OPENAI_API_KEY` = der Key mit Ausgabenlimit. Nicht die direkte 5432-URL.
3. Schema-Änderungen aus `db/schema.sql` (Dateiinhalt, Rate-Limit, ggf. Notebooks) im SQL-Editor des `dev`-Branches ausführen, bevor das Preview gegen die Datenbank spricht. Das Skript muss idempotent bleiben.
4. Preview-URL öffnen, ein Fixture-PDF hochladen, Quelle in der Sidebar prüfen, einmal löschen. Das ist der Integrationsbeweis gegen echtes Supabase.

---

## Offene Fragen an Leonardo

1. Soll die Notebook-Ebene (Tabelle, Default-Notebook „Demo", Quellen an-/abwählbar, ca. 30–45 Min.) in Schritt 2 mitlaufen, oder bleiben Dokumente vorerst global?
2. Sind die selbst verfassten CC0-Fixtures (Muster-Mietvertrag plus Scan-Beispiel) als Seed in Ordnung, oder soll zusätzlich ein kurzes amtliches PDF (gesetze-im-internet.de) für die Demo ins Repo?
