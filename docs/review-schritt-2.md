# Review Schritt 2 — Ingest mit Notebooks

Protokoll des Review-Durchgangs zu Schritt 2. Grundlage waren nur der
freigegebene Plan [`docs/schritt-2-plan.md`](schritt-2-plan.md) und der Diff
`git diff chore/agent-rollen...feature/ingest`, ohne den Verlauf der
Umsetzung (Rolle `@reviewer`, frischer Durchgang).

> Stand dieser Fassung: Befunde dokumentiert, Behebung offen.

## Befunde

| # | Datei und Zeile | Schweregrad | Befund |
| --- | --- | --- | --- |
| R1 | `lib/ingest.ts:175` (`ingestUpload`), `db/schema.sql:40` | wichtig | Doppelter Upload wird nicht erkannt |
| R2 | `lib/ingest.ts:180` | wichtig | Text und Markdown haben kein Mengenlimit |
| R3 | `db/schema.sql:22`, `:40`, `:84`, `:120` | wichtig | Row Level Security ist auf keiner Tabelle aktiv |
| R4 | `lib/pdf.ts:121` | hinweis | `detectSourceType` nimmt jeden `text/*`-Typ als Text an |
| R5 | `lib/pdf.ts:82` | hinweis | pdf.js-Dokument wird nach dem Parsen nicht freigegeben |
| R6 | `lib/rate-limit.ts:60` | hinweis | Zählen und Eintragen sind unter Parallelität nicht atomar |
| R7 | `app/api/documents/handler.ts:40` | hinweis | Löschen ist für jeden Besucher offen |
| R8 | `lib/ingest.ts:195` | hinweis | Fehlender API-Key erscheint dem Nutzer als „gleich noch einmal versuchen“ |
| R9 | `.cursor/rules/umsetzer.mdc:59`, `reviewer.mdc:70` | hinweis | Prüfliste „SQL nur in `lib/db.ts`“ widerspricht `AGENTS.md` |

### R1 — Doppelter Upload wird nicht erkannt (wichtig)

Dieselbe Datei zweimal hochgeladen ergibt zwei Dokumente mit identischen
Chunks. Die Hybridsuche liefert dann jeden Treffer doppelt, die Top-5 im Chat
bestehen zur Hälfte aus Duplikaten, und die Belegliste zeigt zweimal dieselbe
Stelle. Die Prüfliste des Reviewers nennt „kein doppelter Ingest“
ausdrücklich. Außerdem kostet jeder Doppel-Upload Embeddings.

Vorschlag: SHA-256 der Originaldatei als Spalte, eindeutig pro Notebook.
Vor den Embeddings prüfen (spart Kosten), zusätzlich ein eindeutiger Index als
Schutz gegen zwei gleichzeitige Uploads. Antwort `409` mit Titel der
vorhandenen Quelle.

### R2 — Text und Markdown ohne Mengenlimit (wichtig)

Das Seitenlimit greift nur bei PDFs. Eine 4-MB-Textdatei ergibt nachgemessen
2.945 Chunks, rund 1,45 Mio. Tokens und 47 nacheinander laufende
Embedding-Batches, dazu ein einziges `INSERT` mit fast 3.000 Vektoren.
Das sprengt `maxDuration = 60` auf Vercel. Der Nutzer sähe einen Timeout
statt einer Meldung, und es entstünden Kosten für ein Ergebnis, das nie
gespeichert wird.

Vorschlag: eine Obergrenze für Chunks pro Quelle (gleich für alle Typen),
geprüft nach dem Chunking und vor den Embeddings, Antwort `413`.

### R3 — Row Level Security ist aus (wichtig)

Supabase veröffentlicht Tabellen im Schema `public` automatisch über seine
REST-API. Ohne RLS kann jeder mit dem `anon`-Key des Projekts Dokumente lesen,
Chunks ändern oder das Rate-Limit leeren. Der `anon`-Key ist bei Supabase
bewusst nicht geheim. Die App braucht die REST-API nicht, sie spricht direkt
über `pg` mit der Datenbank. Der Security Advisor von Supabase meldet genau
das als Fehler.

Vorschlag: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` auf allen vier Tabellen,
ohne Policies. Der Tabellenbesitzer (die Verbindung der App) ist davon nicht
betroffen, die REST-API sieht nichts mehr. Das Statement ist idempotent.

### R4 — Jeder `text/*`-Typ gilt als Text (hinweis)

`text/html`, `text/csv` oder `text/javascript` werden als Text angenommen. Eine
HTML-Datei landet dann mit allen Tags im Index. Die Funktion stammt aus
Schritt 1, wird aber erst mit diesem Diff wirksam.

Vorschlag: nur `text/plain` bzw. `.txt` als Text, Markdown wie bisher.

### R5 — pdf.js-Dokument wird nicht freigegeben (hinweis)

`getDocumentProxy` hält Worker-Ressourcen und Seitenobjekte. Ohne
`destroy()` bleibt pro Upload Speicher in einer warmen Vercel-Instanz liegen.

Vorschlag: `pdf.destroy()` in einem `finally`.

### R6 — Rate-Limit nicht atomar (hinweis)

Die CTE zählt und fügt in einem Statement ein. Unter `READ COMMITTED` können
zwei gleichzeitige Anfragen trotzdem beide denselben Zählerstand sehen, das
Limit kann also um die Zahl paralleler Anfragen überschritten werden.

Vorschlag: `pg_advisory_xact_lock` pro IP und Endpoint in einer Transaktion.

### R7 — Löschen offen (hinweis)

`DELETE /api/documents/:id` hat weder Login noch Rate-Limit. Jeder Besucher
kann die Quellen der Demo entfernen.

### R8 — Fehlender Key als „gleich noch einmal versuchen“ (hinweis)

Fehlt `OPENAI_API_KEY` in Vercel, meldet der Ingest 502 mit der Bitte, es
gleich erneut zu versuchen. Ein Retry hilft hier nie. Im Log steht die
eigentliche Ursache.

### R9 — Prüfliste widerspricht `AGENTS.md` (hinweis)

`umsetzer.mdc` und `reviewer.mdc` verlangen „SQL nur in `lib/db.ts`“.
`AGENTS.md` sagt: `lib/db.ts` ist der einzige Ort mit `pg`. Schon
`lib/retrieval.ts` aus Schritt 1 hat eigenes SQL, dieser Diff ergänzt
`lib/documents.ts` und `lib/rate-limit.ts` nach demselben Muster. Der Code
folgt `AGENTS.md`, die Prüfliste ist ungenau.

## Geprüft und in Ordnung

- Plan und Commits passen zusammen. Zwei Abweichungen sind begründet: Die
  Fixtures kommen vor den Tests (sonst wären die Tests im eigenen Commit
  rot), und der alte Ingest-501-Test wurde dort angepasst, wo sich das
  Verhalten änderte, damit jeder Commit grün bleibt.
- Seitenzahlen: Chunks des Fixture-PDFs tragen die Seite, auf der ihr Text
  steht („3.450 Euro“ → Seite 2, „Gerichtsstand ist Köln“ → Seite 3), Markdown
  und Text bekommen `page = null`. Getestet.
- Transaktion: Bricht das Chunk-Insert ab, bleibt kein Dokument zurück; ein
  Embedding-Ausfall schreibt gar nichts. Beides getestet, die Embeddings
  laufen vor der Transaktion.
- Cascade: Löschen entfernt die Chunks, Notebook → Dokumente → Chunks ist
  durchgehend `ON DELETE CASCADE`. Getestet.
- Grenzen: 4 MB → 413, 40 Seiten → 413 vor der Textextraktion, unbekannte
  Typen → 415, Scan → 422, kaputtes PDF und leere Datei → 400, jeweils
  deutsch ohne Stacktrace.
- Rate-Limit: Die neunte Anfrage einer IP in 15 Minuten bekommt 429 mit
  `Retry-After`, abgewiesene Anfragen verlängern das Fenster nicht. Chat ist
  weiter 501 und nicht verdrahtet.
- Schema idempotent: zweiter und dritter Lauf fehlerfrei, keine doppelten
  Constraints durch `ADD COLUMN IF NOT EXISTS … REFERENCES`.
- `lib/prompt.ts` ist unverändert, kein Nicht-Ziel berührt, kein Secret im
  Diff, neue Pakete nur die zwei PGlite-Dev-Dependencies.
- `parsePdf` kopiert den Buffer, bevor pdf.js ihn übernimmt. Ohne Kopie wäre
  er danach leer (nachgemessen: 5.390 → 0 Bytes), und in `file_bytes` landete
  eine leere Datei.
