# Review Schritt 2 — Ingest mit Notebooks

Protokoll des Review-Durchgangs zu Schritt 2. Grundlage waren nur der
freigegebene Plan [`docs/schritt-2-plan.md`](schritt-2-plan.md) und der Diff
`git diff chore/agent-rollen...feature/ingest`, ohne den Verlauf der
Umsetzung (Rolle `@reviewer`, frischer Durchgang).

Ablauf: Umsetzer (`@umsetzer`) nach Plan → Reviewer (`@reviewer`) mit
frischem Blick, Befunde zuerst hier dokumentiert → Behebung durch den
Umsetzer, je Befund ein Commit → Tester (`@tester`) mit allen vier
Befehlen ohne Keys plus einem Smoke-Test mit echten Embeddings → Redakteur
(`@redakteur`) für das README.

## Umfang von Schritt 2

Upload von PDF, Markdown und Text bis in die Datenbank, Notebook-Ebene mit
Default-Notebook „Demo“, Quellen in der Sidebar an- und abwählbar und
löschbar, Limits, Rate-Limit für den Upload, eigene CC0-Fixtures, Tests
gegen PGlite. Kein Chat (bleibt `501` bis Schritt 3).

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

## Behebung

| # | Entscheidung | Commit | Beleg |
| --- | --- | --- | --- |
| R1 | übernommen | `ingest: doppelte Uploads pro Notebook mit 409 ablehnen` | SHA-256 in `documents.content_sha256`, Vorabprüfung vor den Embeddings, eindeutiger Teilindex als Netz für gleichzeitige Uploads; 3 Tests (409 ohne Embedding-Aufruf, gleicher Inhalt unter anderem Namen, Index greift) |
| R2 | übernommen | `ingest: Abschnitte pro Quelle begrenzen, auch für Text und Markdown` | `MAX_CHUNKS_PER_SOURCE = 200`, 413 vor den Embeddings; 2 Tests (Limit ohne Embedding-Aufruf, 3,9 MB Text wird abgelehnt) |
| R3 | übernommen | `db: Row Level Security auf allen Tabellen einschalten` | `ENABLE ROW LEVEL SECURITY` auf vier Tabellen, Test prüft `pg_class.relrowsecurity` |
| R4 | übernommen | `ingest: nur text/plain als Text annehmen, nicht jedes text/*` | 2 Tests (HTML, CSV, JS → `unsupported`; `.txt` ohne MIME-Typ → Text) |
| R5 | übernommen | `ingest: pdf.js-Dokument nach dem Parsen freigeben` | `pdf.destroy()` im `finally`, alle Parser-Tests weiter grün |
| R6 | abgelehnt | — | siehe unten |
| R7 | abgelehnt | — | siehe unten |
| R8 | abgelehnt | — | siehe unten |
| R9 | vertagt | — | siehe unten |
| T1 | übernommen | `db: Fehler ruhender Pool-Verbindungen abfangen statt Prozess zu reißen` | Fund des Testers, siehe „Gefundene Fehler“ |

## Abgelehnte Vorschläge (und warum)

- **R6, Advisory Lock fürs Rate-Limit.** Im schlimmsten Fall kommen bei
  parallelen Anfragen einer IP ein, zwei Uploads mehr durch, also ein paar
  Cent. Ein Lock bräuchte eine eigene Transaktion pro Zählung über den
  Pooler und macht den Code schwerer zu erklären. Für eine Demo mit
  5 $ Guthaben ist die einfache Zählung ausreichend; der Duplikatschutz (R1)
  fängt den häufigsten Doppelklick ohnehin ab.
- **R7, Schutz fürs Löschen.** Jeder Schutz ohne Login (Token im Client,
  Admin-Passwort) wäre Schein-Sicherheit oder ein halbes Auth-System, und
  Authentifizierung ist laut `AGENTS.md` ein Nicht-Ziel. Steht jetzt offen
  im README unter „Bewusste Nicht-Ziele“.
- **R8, eigene Meldung für fehlenden Key.** Der Nutzer der Demo kann an einer
  fehlenden Konfiguration nichts ändern, und Konfigurationsdetails gehören
  nicht in eine öffentliche Fehlermeldung. Die Ursache steht im Vercel-Log
  (`[ingest] embedding failed … OPENAI_API_KEY ist nicht gesetzt`), dort sucht
  Leonardo zuerst.
- **R9, Prüfliste in den Rollendateien.** Richtig, aber die Rollendateien
  gehören zu PR #3. Eine Änderung hier würde zwei Pull Requests vermischen.
  Vorschlag für einen eigenen kleinen PR: „SQL nur in `lib/`, `pg` nur in
  `lib/db.ts`“.

## Gefundene Fehler

Alle vier wären in der Demo nicht als Fehler aufgefallen, sondern erst als
schlechte Antwort, als Timeout oder gar nicht.

**1. Doppelte Uploads verdoppelten die Suchtreffer (R1).**
Dieselbe Datei zweimal hochgeladen ergab zwei vollständige Kopien. Die
Hybridsuche hätte jeden Treffer doppelt geliefert, die fünf Belege im Chat
wären zur Hälfte identisch gewesen, und jeder Doppel-Upload hätte erneut
Embeddings gekostet. Behoben über einen Inhalts-Hash pro Notebook; der zweite
Upload bekommt `409` und kostet nichts.

**2. Große Textdateien liefen am Limit vorbei (R2).**
Das Seitenlimit galt nur für PDFs. Nachgemessen ergibt eine 4-MB-Textdatei
2.945 Chunks und 47 Embedding-Batches nacheinander. Auf Vercel wäre das ein
Timeout nach 60 Sekunden gewesen, ohne Meldung, aber mit Kosten. Behoben
durch ein Limit von 200 Abschnitten pro Quelle, geprüft vor den Embeddings.

**3. Alle Tabellen waren über die Supabase-REST-API offen (R3).**
Ohne Row Level Security hätte jeder mit dem öffentlichen `anon`-Key des
Projekts Dokumente lesen oder das Rate-Limit leeren können, an der App
vorbei. Behoben durch RLS ohne Policies; die App selbst verbindet sich als
Tabellenbesitzer und ist nicht betroffen.

**4. Eine getrennte Datenbankverbindung warf eine `uncaughtException` (T1).**
Gefunden vom Tester, nicht im Diff: Beim lokalen Lauf von `next start` gegen
einen PGlite-Socket-Server wurde der Datenbankprozess beendet, während der
Pool eine ruhende Verbindung hielt. `pg` meldet das als `error`-Event am
Pool; ohne Listener wird daraus `⨯ uncaughtException: Connection terminated
unexpectedly`. Der Supabase-Pooler trennt ruhende Verbindungen regelmäßig,
auf Vercel kann so eine Exception die Instanz beenden. Der Code stammt aus
Schritt 1 (`lib/db.ts`), wurde aber erst mit echten Datenbankzugriffen in
diesem Schritt erreichbar. Behoben mit `pool.on("error", …)`; nachgeprüft:
Verbindung getrennt → nur noch `[db] idle client error` im Log, nach dem
Neustart der Datenbank antwortet `GET /api/documents` wieder mit 200.

## Testergebnis (Tester)

Alle vier Befehle in diesem Durchgang ausgeführt, **ohne** `.env.local`,
`DATABASE_URL` und `OPENAI_API_KEY`:

| Befehl | Ergebnis |
| --- | --- |
| `npm run typecheck` | grün |
| `npm run lint` | grün |
| `npm run test` | grün, **100 Tests in 9 Dateien**, ~3 s (vorher 56 in 5) |
| `npm run build` | grün; eine bekannte Webpack-Warnung aus `unpdf` („Critical dependency: the request of a dependency is an expression“), der gebaute Server parst PDFs trotzdem korrekt (Scan → 422 im laufenden `next start`) |

Neu in Schritt 2:

- `tests/unit/ingest.test.ts` (24 Tests): Upload bis zur Zeile in Postgres,
  Seitenzahl am Chunk, Markdown mit `page = null`, alle Ablehnungen (400,
  409, 413, 415, 422, 502) jeweils ohne Zeile in `documents`, Rollback bei
  abgebrochenem Chunk-Insert, Liste, Cascade beim Löschen, 429 bei der
  neunten Anfrage, Hybrid-SQL aus `lib/retrieval.ts` mit Quellenauswahl.
- `tests/unit/pdf-parse.test.ts` (9 Tests): echter Parser an den Fixtures,
  Eval-Fakten auf den erwarteten Seiten, Umlaute, Buffer bleibt erhalten,
  Seitenlimit, Scan-Erkennung, Text-Parsing inkl. ungültigem UTF-8.
- `tests/unit/rate-limit.test.ts` (6 Tests), `tests/unit/schema.test.ts`
  (4 Tests: Indizes, Idempotenz, Default-Notebook, RLS).

Bewusst gestubbt sind nur die Embeddings (deterministisch, normalisiert).
Datenbank-Tests laufen gegen PGlite, nicht gegen Supabase; die Integration
mit dem echten Supabase-Projekt prüft Leonardo im Vercel-Preview.

**Smoke-Test mit echten Embeddings (einmal, 10.11.2026).** `next start` mit
dem echten Key aus `.env.local` gegen einen lokalen PGlite-Socket-Server mit
`db/schema.sql`, Upload von `fixtures/muster-mietvertrag.pdf` über
`POST /api/ingest`:

- `201` nach 2,2 s: 6 Seiten, 6 Chunks, Datei mit 5.390 Bytes in
  `file_bytes`, Hash gesetzt.
- Jeder Chunk hat ein Embedding mit 1.536 Dimensionen und Norm ≈ 1,000, die
  Seiten 1 bis 6 stimmen.
- Derselbe Upload ein zweites Mal: `409`, kein weiterer Embedding-Aufruf.
- Die Sidebar zeigt „muster-mietvertrag · PDF · 6 Seiten · 6 Abschnitte“,
  ausgewählt „1 von 1 Quellen“.

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

## Live-Befund nach dem Merge

**L1 · blocker · NUL-Bytes im PDF-Text.** Beim ersten echten Upload auf
Vercel (ein Lebenslauf aus Word) meldete die App „Die Quelle konnte nicht
gespeichert werden“. Das Vercel-Log zeigte
`invalid byte sequence for encoding "UTF8": 0x00`: pdf.js liefert bei manchen
PDFs U+0000 im Text, Postgres speichert das in `text` nicht.

- **Behebung:** `stripControlChars()` in `lib/pdf.ts`, angewendet auf PDF- und
  Textquellen, bevor gechunkt wird (PR #5).
- **Nachweis:** Ingest-Test mit NUL-Byte gegen PGlite. Ohne Filter schlägt er
  mit genau dem Live-Fehler fehl, mit Filter speichert er.
- **Warum es durchgerutscht ist:** Reviewer und Tester haben nur gegen saubere
  CC0-Fixtures geprüft. PGlite hätte den Fehler gezeigt, der Fall kam in den
  Daten aber nie vor, und die Prüflisten fragten nicht danach.
- **Konsequenz:** Neuer Punkt „Externer Text“ in `reviewer.mdc`, neuer Punkt
  „unsauberer Input bis in die DB“ in `tester.mdc`.

## Bewusst offen (und warum)

- **Chat, Belege, Seitensprung.** Schritt 3; die Originaldatei liegt dafür
  schon in `documents.file_bytes`.
- **Auto-Zusammenfassung und Fragevorschläge.** Schritt 3, laut Plan.
- **Kein Notebook-Umschalter.** Freigegeben ist nur die Ebene, nicht die
  Verwaltung mehrerer Notebooks.
- **Rate-Limit am Chat.** Die Hilfsfunktion steht, verdrahtet wird sie mit
  der Chat-Route in Schritt 3 (`TODO(Schritt 3)` in `lib/rate-limit.ts`).
- **Integration gegen echtes Supabase.** Von dieser Maschine aus nicht
  erreichbar; Nachweis über das Vercel-Preview (Upload, Liste, Löschen).

## Was ein Reviewer in fünf Minuten prüfen kann

1. `npm run test` ohne `.env.local` — laufen die Datenbank-Tests wirklich
   gegen Postgres (PGlite) und nicht gegen einen Mock?
2. `lib/documents.ts` — ein `INSERT` für alle Chunks, in derselben
   Transaktion wie Dokument und Datei?
3. `db/schema.sql` zweimal im Supabase-SQL-Editor ausführen — läuft der
   zweite Lauf fehlerfrei?
4. `fixtures/muster-mietvertrag.pdf` zweimal hochladen — kommt beim zweiten
   Mal `409`?
5. `git log` — erzählt die Historie den Weg: Plan, Umsetzung, Review-Befunde,
   je ein Commit pro Behebung?
