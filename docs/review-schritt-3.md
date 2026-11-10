# Review Schritt 3 — Chat mit Belegen

Protokoll des Reviews zu Schritt 3. Grundlage: der freigegebene Plan
[`docs/schritt-3-plan.md`](schritt-3-plan.md) (mit den Entscheidungen von
Leonardo vom 10.11.2026) und der Diff `git diff plan/schritt-3-chat...feature/chat`.

**Ehrlicher Hinweis zum Ablauf:** Teil 3a wurde in *einem* Durchgang
umgesetzt und danach mit der Prüfliste aus `.cursor/rules/reviewer.mdc`
gegen den eigenen Diff geprüft. Das ist kein frischer Reviewer-Chat, wie
`docs/agents.md` ihn vorsieht. Leonardos Review von PR „Schritt 3a“ ist
deshalb der eigentliche unabhängige Blick. Vor Teil 3b (UI) läuft
`@reviewer` zusätzlich in einem frischen Chat über den gesamten Diff.

## Umfang von Teil 3a (Backend)

`POST /api/chat` mit Hybrid-Suche, Belegliste als `data-citations` vor dem
Text, Absage ohne Modellaufruf unter der Ähnlichkeitsschwelle, Rate-Limit,
`GET /api/documents/[id]/file` für den Seitensprung, Konfigurationsfehler
ohne Retry-Hinweis (auch beim Upload, R8 aus Schritt 2). Dazu die sieben
Auffälligkeiten aus dem Plan, die Leonardo in Schritt 3 behoben haben will.
Kein UI, keine Zusammenfassung (Teil 3b).

## Behebungen aus dem Plan (Auffälligkeiten 1–7)

| # | Auffälligkeit | Commit | Beleg |
| --- | --- | --- | --- |
| 1 | Leere Auswahl durchsuchte alle Dokumente | `retrieval: … nie ohne Auswahl suchen`, `chat: Frage suchen und Antwort …` | `retrieve()` ohne IDs → `[]` ohne Embedding; Route → 400 „Wähle mindestens eine Quelle aus …“, Embedding und Modell nicht aufgerufen (Test) |
| 2 | Nicht-UUID-ID → 500 | `chat: Frage suchen und Antwort …` | 400 vor jeder Datenbankabfrage; alter Test „filtert ungültige documentIds“ bewusst umgeschrieben |
| 3 | Prompt kürzte bei 2.400 < 2.880 Zeichen | `prompt: Chunks nicht unter ihrer Maximallänge kürzen` | `MAX_CHUNK_CHARS` aus `lib/chunk.ts`; Test: jeder von `chunkPages` erzeugte Chunk steht ganz im Prompt (längster > 2.400) |
| 4 | Quellenblöcke nicht escaped | `prompt: Quellenblöcke gegen Fremdtext … absichern` | Test: Titel mit `"`, Chunk mit `</quelle>` und `< QUELLE nr="7">`, Frage mit `</quelle>` → genau drei Blöcke, kein fremdes `nr=` |
| 5 | `retrieve()` nicht gegen PGlite testbar | `retrieval: Abhängigkeiten übergeben …` | `tests/unit/retrieval.test.ts`, 5 Tests |
| 6 | `href: null`, veralteter `TODO(Schritt 2)` | `prompt: Belege auf die Originaldatei … verlinken` | `href = /api/documents/<id>/file#page=N`, TODO entfernt |
| 7 | Frage ohne Bereinigung | `chat: Steuerzeichen aus der Frage entfernen …` | Gegenprobe: NUL-Byte direkt an `retrieve()` → PGlite wirft `invalid byte sequence … 0x00` (Live-Fehler L1); über die Route → 200 mit Treffer auf Seite 2. Gegen den vorigen Commit schlagen zwei Tests mit genau diesem Fehler fehl. |

`SYSTEM_PROMPT` ist unverändert: `REFUSAL_TEXT` wird per Template
eingesetzt, ein Test vergleicht den SHA-256 des Prompts mit dem Stand vor
Schritt 3.

## Befunde aus dem Review gegen den eigenen Diff

| # | Datei | Schweregrad | Befund |
| --- | --- | --- | --- |
| S1 | `app/api/chat/handler.ts` (`parseChatRequest`) | wichtig | `documentIds` war unbegrenzt und ging vollständig in `ANY($2::uuid[])` |
| S2 | `lib/chat.ts` (`shouldRefuse`), `lib/retrieval.ts` | wichtig | Die Absage-Schwelle sah nur die Top-5 nach RRF, nicht den besten Vektortreffer |
| S3 | `app/api/chat/handler.ts` (`createUIMessageStream`) | wichtig | Fehler in `execute()` außerhalb von `streamText` wurden nicht protokolliert |
| S4 | `app/api/chat/handler.ts` | hinweis | Embedding und Suche vor dem Stream haben keinen eigenen Timeout |
| S5 | `app/api/chat/handler.ts`, `app/api/ingest/handler.ts` | hinweis | Die 429-Antwort ist in zwei Handlern gleich ausformuliert |
| S6 | `lib/documents.ts`, `lib/rate-limit.ts` | hinweis | SQL außerhalb von `lib/db.ts` — Prüfliste vs. `AGENTS.md` (bekannt als R9) |

### S1 — Unbegrenzte Quellenauswahl (wichtig)

Ein Body mit zehntausenden UUIDs lief durch Validierung, Rate-Limit und in
die Datenbank. Behoben: höchstens 100 IDs (`MAX_SELECTED_SOURCES`), sonst
400, bevor Rate-Limit, Datenbank oder Embedding laufen. Test vorhanden.

### S2 — Schwelle auf den falschen Kandidaten (wichtig)

RRF addiert Ränge. Ein Chunk auf Rang 10 in beiden Listen (2/70 ≈ 0,029)
schlägt den besten Vektortreffer, der nur in einer Liste steht (1/61 ≈
0,016). Fünf solcher Chunks drängen den besten Treffer aus den Top-5, und
die Schwelle hätte trotz passender Quelle abgelehnt. Behoben: Das SQL
liefert per `max(...) OVER ()` die beste Ähnlichkeit aller Kandidaten, die
Fensterfunktion läuft vor `LIMIT`. Tests: `limit: 1` kennt dieselbe beste
Ähnlichkeit wie `limit: 40`; `shouldRefuse` lässt durch, wenn nur der
verdrängte Kandidat über der Schwelle liegt.

### S3 — Verschluckte Fehler im Stream (wichtig)

`createUIMessageStream({ onError })` machte aus jedem Fehler in `execute()`
eine Meldung an den Nutzer, aber ohne Logzeile. In Vercel wäre davon nichts
zu sehen gewesen. Behoben: `onError` protokolliert mit `[chat]`-Präfix. Der
Test schlägt gegen den vorigen Stand fehl.

### S4 — Kein Timeout vor dem Stream (hinweis, offen)

Der 45-s-Timeout gilt für `streamText`. Das Embedding der Frage davor läuft
mit `maxRetries: 2` in `embedTexts()` ohne eigenes Signal. Im schlimmsten
Fall greift dann der Plattform-Timeout (`maxDuration = 60`) ohne unsere
Meldung. Offen gelassen: Ein Frage-Embedding dauert normal unter einer
Sekunde, und die Änderung berührt die Signatur von `embedTexts`, die der
Ingest teilt. Kandidat für Schritt 4.

### S5 — Doppelte 429-Formulierung (hinweis, offen)

Ingest und Chat bauen die 429-Antwort mit Minutenangabe jeweils selbst.
Offen gelassen, weil die Texte sich unterscheiden („Uploads“/„Fragen“) und
ein Helfer für zwei Aufrufer mehr Indirektion als Nutzen bringt. Kommt die
Zusammenfassung (Teil 3b) als dritter Aufrufer, wird er zusammengezogen.

### S6 — SQL außerhalb von `lib/db.ts` (hinweis, bekannt)

`existingDocumentIds` und `getDocumentFile` liegen in `lib/documents.ts`,
wie die übrigen Dokumentfunktionen seit Schritt 2. `AGENTS.md` erlaubt das
(„einziger Ort mit `pg`“), die Prüfliste der Rollen sagt „SQL nur in
`lib/db.ts`“. Das ist R9 aus Schritt 2 und bleibt einem eigenen PR an den
Rollendateien vorbehalten.

## Geprüft und in Ordnung

- **Richtigkeit:** Reihenfolge `data-citations` vor dem ersten
  `text-delta` ist per SSE-Body getestet, ebenso Systemprompt,
  `temperature`, `maxOutputTokens` und Anzahl Quellenblöcke im Aufruf des
  Mock-Modells.
- **Stille Fehler:** Timeout endet im AI SDK ohne Fehler-Chunk; deshalb
  schreibt der Handler nach dem Timeout selbst eine Meldung (Test mit
  hängendem Mock-Modell). Kein leeres `catch` im neuen Code.
- **Datenintegrität:** Abgewählte Quellen tauchen nie in den Belegen auf
  (Test); fremde, aber gültige UUIDs fallen über die Schnittmenge mit dem
  Notebook heraus.
- **Kosten und Grenzen:** Ungültige Anfragen zählen nicht zum Rate-Limit
  und kosten nichts; Absagen kosten nur das Embedding und zählen.
- **Sicherheit:** Markdown und Text werden als `text/plain` mit `nosniff`
  ausgeliefert, nie als HTML (Test mit `<script>`). Keine Keys im Diff;
  `.env*` nicht berührt.
- **Systemprompt:** byte-gleich (SHA-256-Test).

## Testergebnis

`npm run typecheck`, `npm run lint`, `npm test` (151 Tests in 13 Dateien)
und `npm run build` ohne `DATABASE_URL` und `OPENAI_API_KEY` grün. Vorher
(main nach PR #5): 104 Tests.

Nicht automatisch geprüft, nur live möglich: Antwortqualität von
`gpt-4o-mini`, Streaming ohne Pufferung auf Vercel, `#page=` im echten
Browser-Viewer, Absage bei D1–D3 mit echten Embeddings.

## Frischer Review vor 3b

Rolle `@reviewer` in einem frischen Durchgang. Eingabe nur `AGENTS.md`,
`docs/schritt-3-plan.md` und der Diff `origin/main...origin/plan/schritt-3-chat`
(PR #7, auf `main` über PR #8). Befunde, die schon als S1–S6 oben stehen,
sind nur referenziert.

**Ergebnis: kein `blocker`.** Systemprompt byte-gleich (geprüft per
Textvergleich gegen `main`, zusätzlich zum SHA-256-Test), keine neue
Abhängigkeit, kein Nicht-Ziel berührt, keine Keys im Diff.

| # | Datei und Zeile | Schweregrad | Befund |
| --- | --- | --- | --- |
| F1 | `lib/retrieval.ts:112–122` (`vector_hits`) | wichtig | HNSW-Index filtert erst nach dem Index-Scan; eine kleine Auswahl kann ohne Vektortreffer bleiben und still abgesagt werden |
| F2 | `lib/errors.ts:23–35`, `app/api/chat/handler.ts:98–110` | wichtig | Datenbank-Konfigurationsfehler (Passwort, fehlendes Schema) gelten als vorübergehend und raten zum erneuten Versuch |
| F3 | `lib/prompt.ts:106` (`neutralizeSourceTags`) | hinweis | Entschärfung greift nicht bei unsichtbaren oder Vollbreiten-Zeichen im Tag |
| F4 | `app/api/chat/handler.ts:29` | hinweis | `stripControlChars` aus `lib/pdf.ts` zieht `unpdf`/pdf.js in das Bundle der Chat-Route |
| F5 | `lib/rate-limit.ts:54–96`, `:104` | hinweis | Zählung nicht atomar; IP-Ermittlung nur hinter Vercel spoofsicher |
| F6 | `app/api/documents/handler.ts:91`, `:94` | hinweis | `filename*` mit nicht erlaubten Zeichen; gelöschte Datei bleibt 5 min im Browser-Cache |
| F7 | `app/api/chat/handler.ts:86–93` | hinweis | Länge der ID-Liste wird nach der UUID-Prüfung jedes Elements geprüft |
| F8 | `tests/unit/chat.test.ts` | hinweis | Lücken: Abbruch durch den Client und HNSW-Pfad ungetestet |

### F1 — Vorgefilterte Vektorsuche über HNSW (wichtig)

`db/schema.sql` legt `chunks_embedding_hnsw_idx` an. Nutzt der Planer ihn
für `ORDER BY embedding <=> $1 LIMIT $2`, wendet pgvector die Bedingung
`document_id = ANY($3)` erst **nach** dem Index-Scan an (Standard
`hnsw.ef_search = 40`). Liegen die 40 nächsten Chunks alle in abgewählten
Dokumenten, kommt aus `vector_hits` nichts oder zu wenig zurück. Dann ist
`vectorSimilarity` überall `null`, `shouldRefuse` sagt ab, obwohl die
gewählte Quelle passt — eine stille Absage, genau die Fehlerart, die die
Demo kaputt macht (Plan, Entscheidung 4 und 9). In den Tests fällt es nicht
auf, weil PGlite bei wenigen Chunks sequenziell scannt.

Vorschlag: Für die Suche `SET LOCAL hnsw.iterative_scan = relaxed_order`
(pgvector ≥ 0.8, auf Supabase verfügbar) in derselben Transaktion setzen
oder `hnsw.ef_search` anheben; alternativ bis zu einer Größe X die
exakte Suche erzwingen. Im Eval (Schritt 4) einen Fall „eine kleine Quelle
neben einer großen angehakt“ aufnehmen.

### F2 — Datenbank-Konfiguration gilt als vorübergehend (wichtig)

`classifyUpstreamError` kennt als Konfiguration nur `ConfigError` und
OpenAI-401/403. `password authentication failed` (28P01), `relation …
does not exist` (42P01, Schema fehlt), `Tenant or user not found` oder
ein Zertifikatsfehler landen als `transient` und kommen als 500 mit
„Bitte versuche es erneut“ an. Der Test „meldet einen Datenbankfehler als
500“ belegt genau das mit `relation "documents" does not exist`. Plan,
Entscheidung 8: „Nur der letzte Fall [vorübergehend] darf zum erneuten
Versuch raten.“ Der Plan nennt DB-Fehler nicht ausdrücklich, deshalb
`wichtig` statt `blocker`.

Vorschlag: In `lib/errors.ts` Postgres-`code` 28P01, 28000, 3D000, 42P01
und `ENOTFOUND`/`SELF_SIGNED_CERT_IN_CHAIN` als `config` einordnen; gilt
dann auch für `app/api/documents/handler.ts` und den Ingest.

### F3 — Lücken in `neutralizeSourceTags` (hinweis)

`/<(\s*\/?\s*quelle)/gi` fängt `</quelle>` und `< / QUELLE>`, aber nicht
`<\u200B/quelle>`, `</\u00ADquelle>`, `</que\u200Blle>` oder
`＜/quelle＞` (nachgeprüft mit Node). `stripControlChars` entfernt nur
C0-Steuerzeichen, keine Formatzeichen (`\p{Cf}`). Ob ein Modell diese
Varianten als Blockende liest, ist offen; eine harte Grenze ist es nicht.
Titel sind über `escapeAttribute` sauber.

Vorschlag: Vor dem Prompt-Bau `\p{Cf}` entfernen und NFKC normalisieren,
oder statt fester Tags pro Anfrage einen zufälligen Begrenzer verwenden.
Ein Test pro Variante.

### F4 — pdf.js im Bundle der Chat-Route (hinweis)

Der Build warnt mit Import-Trace `lib/pdf.ts → app/api/chat/handler.ts`.
Der Chat braucht nur die Regex, zieht aber `unpdf` mit; das kostet
Kaltstart in genau der Route, die in der Demo schnell sein soll.

Vorschlag: `stripControlChars` in ein kleines `lib/text.ts` verschieben
und aus `lib/pdf.ts` und dem Chat dort importieren.

### F5 — Rate-Limit: Nebenläufigkeit und IP (hinweis)

`DELETE` und das zählende `INSERT … WHERE n < $4` sind zwei Statements
ohne Sperre; parallele Anfragen derselben IP sehen beide `n = 19` und
kommen beide durch. Für eine Demo verkraftbar. `x-forwarded-for` ist auf
Vercel nicht spoofbar: Laut Vercel-Doku („Request headers“) überschreibt
die Plattform den Header und reicht keine externen IPs durch. Außerhalb von
Vercel (lokal, anderer Host) lässt sich der erste Eintrag frei setzen;
IPv6 zählt je Adresse, nicht je /64.

Vorschlag: `x-vercel-forwarded-for` bevorzugt lesen und im Kommentar
festhalten, dass die Annahme nur hinter Vercel gilt; optional
`pg_advisory_xact_lock(hashtext(endpoint || ip))` in einer Transaktion.

### F6 — Header der Datei-Route (hinweis)

Header-Injection über den Dateinamen ist ausgeschlossen:
`encodeURIComponent` kodiert CR/LF und alles Nicht-ASCII. Es lässt aber
`'`, `(`, `)`, `*` stehen, die in RFC 5987 kein `attr-char` sind; strenge
Parser verwerfen dann den Namen. `Cache-Control: private, max-age=300`
heißt: Eine gelöschte Quelle lässt sich im selben Browser noch fünf Minuten
öffnen. UUID-Prüfung, Filter auf das Notebook, `nosniff` und
`text/plain` für Markdown/Text sind in Ordnung; Größe ist durch das
Upload-Limit (4 MB) gedeckelt.

Vorschlag: Die vier Zeichen zusätzlich prozentkodieren; `no-store` oder
`max-age=0, must-revalidate`, falls Löschen sofort wirken soll.

### F7 — Reihenfolge in `parseChatRequest` (hinweis)

`rawIds.every(isUuid)` läuft über das ganze Array, bevor
`MAX_SELECTED_SOURCES` greift. Bei sehr großen Bodys (bis zum Vercel-Limit
von 4,5 MB) ist das unnötige Arbeit; S1 ist damit nur teilweise geschlossen.

Vorschlag: Länge zuerst prüfen, dann die Elemente.

### F8 — Testlücken (hinweis)

Die Tests prüfen Verhalten, nicht nur Mocks: Handler gegen PGlite mit
echtem Schema und echtem `HYBRID_SQL`, `MockLanguageModelV2` des AI SDK,
SSE-Body geparst, Reihenfolge der Chunks geprüft. Ungetestet bleiben der
Abbruch über `request.signal` (Nutzer drückt „Stopp“: Es darf keine
Timeout-Meldung kommen, Zeile 223) und der Index-Pfad aus F1.

Vorschlag: Ein Test mit `AbortController` am Request; F1 im Eval statt in
Unit-Tests.

### Referenzierte Befunde

S4 (kein Timeout vor dem Stream) und S5 (doppelte 429-Formulierung) sind
weiterhin offen und richtig eingeordnet. S6/R9 gilt unverändert für
`existingDocumentIds` und `getDocumentFile`.

### Geprüft und in Ordnung

- **Reihenfolge im Handler:** Body → Rate-Limit → Schnittmenge mit dem
  Notebook → Suche → Absage → Modell → Stream; ungültige Anfragen zählen
  nicht und kosten nichts.
- **Fehlerpfade:** `getDatabase()` ist lazy, ein fehlendes `DATABASE_URL`
  wirft deshalb im `try` und wird zu 503. `model()` wird erst nach der
  Absageprüfung gebaut. `RetryError.lastError` wird ausgewertet. Kein leeres
  `catch`; jede Fehlerstelle loggt mit Präfix.
- **Stream-Abbruch:** Timeout und `request.signal` über `AbortSignal.any`,
  Timer im `finally` geräumt, Timeout-Meldung nur ohne Nutzerabbruch.
- **SQL:** Pflichtfilter in beiden Teilabfragen, alle Werte als Parameter,
  `replace('&','|')` arbeitet auf der ausgegebenen tsquery mit gequoteten
  Lexemen und öffnet keine Injection. `max(...) OVER ()` vor `LIMIT`
  richtig (S2).
- **Kürzung:** `MAX_CHUNK_CHARS` entspricht der Garantie aus
  `lib/chunk.ts`; der Chunker erzeugt nichts Längeres, also schneidet der
  Prompt keinen regulären Chunk (Architekturregel 5).
- **Systemprompt:** byte-gleich zu `main`.
- **Meldungen in `lib/chat.ts`:** deutsch, ohne Stacktrace; nur
  `searchFailed` rät auch bei Konfiguration zum erneuten Versuch (F2).

### Testergebnis des frischen Durchgangs

Selbst ausgeführt auf `origin/plan/schritt-3-chat`: `npm run typecheck`,
`npm run lint`, `npm test` (151 Tests in 13 Dateien) und `npm run build`
grün. Der Build warnt nur über `unpdf` (siehe F4).

## Nacharbeit aus dem frischen Review (3b, erster PR)

Branch `fix/retrieval-und-db-fehler`, nur Backend, keine UI. Vor jedem
Commit liefen `@tester` und die `@reviewer`-Prüfliste gegen den gestagten
Diff, danach der Pre-commit-Hook (typecheck, lint, test).

| # | Status | Commit | Kurz |
| --- | --- | --- | --- |
| F1 | behoben | `9bdf98a` | iterativer HNSW-Scan in einer Transaktion um die Suche |
| F2 | behoben | `17e87d6` | Datenbank-Konfigurationsfehler → 503 in Chat, Upload, Quellen |
| F4 | behoben | `ef4b1d8` | `stripControlChars` in `lib/text.ts`, Chat-Route ohne `unpdf` |

F3, F5–F8 sowie S4, S5 und S6/R9 bleiben offen.

### F1 — behoben

`retrieve()` setzt `SET LOCAL hnsw.iterative_scan = relaxed_order` und
führt `HYBRID_SQL` in derselben Transaktion aus. Gewählt statt eines höheren
`hnsw.ef_search`, weil das die Grenze nur verschiebt (bei 41 näheren
Chunks wäre sie wieder da) und jede Frage teurer macht; der iterative Scan
sucht nur dann weiter, wenn `LIMIT` nicht erfüllt ist, gedeckelt durch
`hnsw.max_scan_tuples` (20.000). Verfügbarkeit: PGlite bringt pgvector
0.8.7 mit (geprüft), Supabase dokumentiert 0.8.0 mit iterativem Scan.
`SET LOCAL` statt `SET`, weil der Pooler auf Port 6543 im
Transaktionsmodus läuft. Da `relaxed_order` nur ungefähr sortiert, sammelt
ein `MATERIALIZED`-CTE (`vector_candidates`) die Treffer, und `vector_hits`
vergibt den Rang exakt nach Abstand.

Folge für die Typen: `RetrievalDeps.db` und `ChatDeps.db` sind jetzt
`Database` (mit `transaction`) statt `Queryable`. Die Produktion übergibt
schon `getDatabase()`, PGlite erfüllt die Schnittstelle ebenfalls.

Test (`tests/unit/retrieval.test.ts`, „retrieve() über den HNSW-Index“):
300 Chunks einer großen Quelle liegen näher an der Frage als der eine Chunk
der kleinen; gesucht wird nur in der kleinen. Bei so wenig Daten nimmt
PGlite sonst Seq-Scan oder den B-Baum auf `document_id`; `enable_sort = off`
in der Testsitzung lässt nur den HNSW-Pfad übrig, ein eigener Test prüft
per `EXPLAIN`, dass er wirklich genommen wird. **Ohne den Fix rot**
(`expected [] to have a length of 1 but got +0`), auch mit dem neuen CTE,
aber ohne das `SET`. Ein weiterer Test prüft, dass die Einstellung nach der
Suche nicht in der Sitzung hängen bleibt.

Ehrlich vermerkt: Mit exakt orthogonalen Testvektoren fand auch der
iterative Scan nichts (entarteter HNSW-Graph); die Testvektoren tragen
deshalb deterministisches Rauschen wie echte Embeddings.

Restrisiko: Hätte das Supabase-Projekt pgvector < 0.8, scheiterte das
`SET` mit 42704 bzw. 22023, und der Chat meldete nach F2 einen
Konfigurationsfehler (42704). Vor dem Merge einmal im SQL-Editor
`select extversion from pg_extension where extname = 'vector';` prüfen.

### F2 — behoben

`classifyUpstreamError` wertet als `config`: SQLSTATE 28P01, 28000, 3D000,
42P01, 42883 und zusätzlich 42704 (Typ `vector` oder Parameter fehlt, siehe
Restrisiko F1); die Node-Codes `ENOTFOUND`, `ECONNREFUSED` und
Zertifikatsfehler (`SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`
u. a.); ohne Code die Meldungen „Tenant or user not found“ (Supavisor),
„self-signed certificate“ und „does not support SSL connections“. Die
Prüfung folgt `cause` und `RetryError.lastError`. `ETIMEDOUT`,
`ECONNRESET`, 53300 und 40001 bleiben bewusst vorübergehend.

Ingest- und Dokument-Handler prüften bisher nur `instanceof ConfigError`
und nutzen jetzt dieselbe Klassifizierung (`isConfigError`). Der Upload
meldet also bei falschem Passwort 503 statt „Die Quelle konnte nicht
gespeichert werden. Bitte versuche es erneut.“

**Bewusst geändert:** Der Chat-Test „meldet einen Datenbankfehler als 500
ohne interne Details“ schrieb das alte Verhalten fest (fehlendes Schema →
500 mit Retry-Hinweis). Er heißt jetzt „meldet ein fehlendes Schema als 503
ohne Retry-Hinweis (F2)“; ein neuer Test hält fest, dass ein echter
Laufzeitfehler („Connection terminated unexpectedly“) weiter 500 mit
Retry-Hinweis bleibt. Neue Tests: 13 Fälle in `errors.test.ts`, zwei im
Chat, drei für Upload, Quellenliste und Löschen. Vor dem Fix 17 rot.

### F4 — behoben

`stripControlChars` liegt in `lib/text.ts` ohne Abhängigkeiten; `lib/pdf.ts`
und `app/api/chat/handler.ts` importieren von dort, die Tests dazu stehen
in `tests/unit/text.test.ts`. `AGENTS.md` nennt die neue Datei.

Gemessen mit `npm run build`: Vorher endete der Import-Trace der
`unpdf`-Warnung bei `app/api/chat/route.ts`, und die Chat-Route lud einen
Chunk mit dem `unpdf`-Wrapper samt Verweis auf den pdf.js-Chunk (1,3 MB,
dort lazy). Nachher nennt der Trace nur noch die Ingest-Route, und das
Chat-Bundle verweist nicht mehr auf pdf.js. Die Warnung selbst bleibt,
weil der Ingest `unpdf` braucht. Der Gewinn am Kaltstart ist klein, weil
pdf.js schon vorher erst beim Parsen geladen wurde. Test: Der Chat-Handler
lässt sich mit unladbarem `unpdf` (`vi.doMock`) importieren; vor dem Fix rot.

### Testergebnis

`npm run typecheck`, `npm run lint`, `npm test` (173 Tests in 14 Dateien)
und `npm run build` grün auf `ef4b1d8`.

## 3b, zweiter PR: Chat-Oberfläche (Plan-Commits 9–11)

Branch `feature/chat-ui`, nur Plan-Commits 9–11; Zusammenfassung und
Fragevorschläge (12–14) folgen in einem eigenen PR. Vor jedem Commit liefen
`@tester` und die `@reviewer`-Prüfliste gegen den gestagten Diff, danach
der Pre-commit-Hook. Kein frischer Reviewer-Chat: Das ist Leonardos Review
des PRs bzw. der Durchgang am Schrittende.

| Commit | Inhalt |
| --- | --- |
| `f154400` | `@ai-sdk/react@2.0.288`, exakt gepinnt — die Version, die selbst `ai@5.0.285` pinnt (`npm ls`: eine Kopie von `ai` und `provider-utils`) |
| `79f005b` | `components/chat.tsx` mit `useChat`, `lib/chat-client.ts` (Request-Form, Fehlermeldungen), `lib/citations.ts` (`splitCitations`, `splitParagraphs`) |
| `e773f61` | `components/citation-popover.tsx`, `popoverPlacement()`, Safari-Grenze im README |

### Entscheidungen

- **Request-Form.** `prepareSendMessagesRequest` schickt genau
  `{ question, documentIds }`. Die Auswahl kommt pro Frage über
  `sendMessage(…, { body: { documentIds } })`, nicht über eine Closure im
  Transport: Der Transport lebt so lange wie der Chat, die Häkchen ändern
  sich.
- **Fehlermeldungen.** Bei `!response.ok` wirft der Transport des SDK den
  Antwort-Body als `Error.message`, also unser JSON. `chatErrorMessage()`
  liest daraus `error`, übernimmt den deutschen `errorText` aus dem Stream
  und ersetzt englischen oder technischen Rohtext („Failed to fetch“,
  „Load failed“, „An error occurred.“, HTML der Plattform).
- **Absage.** Leere Belegliste (Stufe 1) oder Antwort, die mit
  `REFUSAL_TEXT` beginnt (Stufe 2), erscheint als eigener, ruhiger Block
  mit Hinweis auf die Auswahl. Keine Belegliste darunter.
- **`[n]` außerhalb der Liste** bleibt sichtbar, gestrichelt rot mit
  Warnsymbol und Tooltip. Gleiche Form wie `extractCitationNumbers()`:
  `[1, 2]` und `[a]` sind kein Beleg und bleiben Text.
- **Belegliste unter der Antwort** zeigt nur tatsächlich zitierte Belege
  in der Reihenfolge des ersten Auftretens; jeder Eintrag öffnet dieselbe
  Karte wie `[n]`.
- **Popover ohne Bibliothek.** Kein shadcn-Popover im Repo, und
  `@radix-ui/react-popover` brächte floating-ui mit. `popoverPlacement()`
  entscheidet oben/unten und links/rechts nach der Lage des Belegs; unter
  `sm` liegt die Karte als Leiste am unteren Rand.
- **Keine Komponenten-Tests.** `vitest.config.ts` läuft bewusst ohne
  jsdom; jsdom plus Testing Library wären zwei bis drei neue Pakete für
  wenig Gewinn. Die Logik steckt in `lib/` und ist dort getestet. Statt
  eines Komponenten-Tests läuft in `tests/unit/chat-client.test.ts` die
  Klasse `Chat` aus `@ai-sdk/react` (dieselbe, die `useChat` hält) gegen
  den echten Handler mit PGlite und `MockLanguageModelV2`. Die Oberfläche
  selbst ist per Playwright gegen einen lokalen Mock geprüft (Skript und
  Screenshots außerhalb des Repos).

### Befunde aus den Pro-Commit-Reviews

| # | Commit | Schweregrad | Befund | Behebung |
| --- | --- | --- | --- | --- |
| U1 | 9 | hinweis | Commit-Text nannte nur `swr` und `throttleit` als neue Pakete im Lockfile, `dequal` und `use-sync-external-store` fehlten | Text vor dem Push korrigiert |
| U2 | 10 | wichtig | Ohne eigenes Parsing zeigte der Fehlerzustand bei 400/429/503 den rohen JSON-Body `{"error":…}` | `chatErrorMessage()`, Tests für JSON, Stream-Text, HTML, Netzfehler |
| U3 | 10 | wichtig | Der Fehler hing global an `useChat` und verschwand mit der nächsten Frage; die abgebrochene Antwort sah danach fertig aus (im Playwright-Lauf gefunden) | Vermerk „abgebrochen“/„angehalten“ pro Nachricht, vor dem Push in Commit 10 eingearbeitet |
| U4 | 10 | hinweis | `pageLabel` exportiert ohne zweiten Aufrufer | nicht mehr exportiert |
| U5 | 11 | hinweis | `tailwind-merge` strich `sm:inset-x-auto`, sobald `sm:left-0` oder `sm:right-0` folgte (an der `twMerge`-Ausgabe geprüft). Ab `sm` blieb damit `left: 0.75rem` aus der Mobilvariante stehen, die Lage hing an überbestimmten `left`/`right`/`width` | explizite `left`/`right`-Klassen statt `inset-x`; danach per `boundingBox` gemessen: Karte 320 px breit, rechtsbündig am Beleg |
| U6 | 11 | wichtig | `animate-fade-in` an den Verlaufseinträgen hinterlässt `transform` (fill-mode `both`); damit wäre die fest positionierte Karte auf schmalen Fenstern im Eintrag gelandet | Animation an den Einträgen entfernt |
| U7 | 10 | hinweis | Die Startseite wächst von 118 auf 186 kB First Load JS (`next build`), vor allem durch den UI-Teil von `ai` samt Schema-Validierung der Stream-Chunks | akzeptiert: Preis von `useChat` (Frage 1); offen für Schritt 4, falls es auf dem Beamer spürbar ist |
| U8 | 10 | hinweis | `data-citations` wird im Client nicht gegen ein Schema geprüft | bewusst offen: Der Server ist unserer; `href` baut `citationHref()` serverseitig, und React 19 blockiert `javascript:`-URLs |

### Geprüft und in Ordnung

- Kein Secret im Diff, keine Inline-Styles, keine neue Styling-Bibliothek,
  kein `console.log`, keine Server-Importe im Client (`lib/chat.ts` und
  `lib/prompt.ts` ziehen nur Typen und Konstanten).
- `SYSTEM_PROMPT`, API-Routen und Schema unverändert.
- Senden ist ohne angehakte Quelle gesperrt (Hinweis, auf schmalen
  Fenstern mit „Quellen öffnen“); der Server antwortet trotzdem 400
  (Test über den Client).
- Rot-grün: Ohne `prepareSendMessagesRequest` schlagen 6 der 11
  Client-Tests fehl, weil der Server den Verlauf statt der Frage bekommt.

### Von Hand geprüft (Playwright gegen lokalen Mock)

Echte Handler gegen PGlite mit Stub-Embeddings und
`MockLanguageModelV2` (verzögert gestreamt), `next dev` davor. Breit
1440×900, schmal 390×844:

- leer, ohne Quelle gesperrt, sendet, Belege da/Text noch nicht, streamt
  mit Stopp-Button, fertige Antwort mit `[1]`, `[1][2]` und markiertem
  `[7]`, Absage, Fehler mitten im Stream, 400 mit JSON-Body, 504 mit
  HTML-Body, angehalten;
- Belegkarte per Klick auf `[n]` und aus der Belegliste; Escape schließt
  und gibt den Fokus an `[n]` zurück, Enter öffnet erneut, Tab erreicht
  den Link, Tab aus der Karte und Klick daneben schließen;
- Link `/api/documents/<id>/file#page=2`, `target=_blank`,
  `rel=noopener`;
- schmal: Karte als Leiste am unteren Rand (12 px Abstand, volle Breite).

Nicht lokal prüfbar: Streaming über Vercel mit `gpt-4o-mini` und der
Sprung auf die Seite im PDF-Viewer von Chrome (der Headless-Browser hat
keinen). Beides testet Leonardo auf Production nach dem Merge.

### Offen

- Fragevorschläge statt der drei festen Beispielfragen: Commit 14
  (`TODO(Schritt 3, Commit 14)` in `components/chat.tsx`).
- „Unbelegt“-Hinweis für Antworten ohne `[n]`: `TODO(Schritt 4)` in
  `lib/prompt.ts`, hier nicht umgesetzt.
- Verlauf ist nach einem Reload weg (Entscheidung 3).
- F3, F5–F8, S4, S5, S6/R9 aus den früheren Durchgängen.

### Testergebnis

`npm run typecheck`, `npm run lint`, `npm test` (197 Tests in 16 Dateien)
und `npm run build` ohne `DATABASE_URL` und `OPENAI_API_KEY` grün auf
`e773f61`.

## Live-Befund L2: Belege mehrfach und scheinbar falsch

Leonardo nach dem Merge von #12 auf Production: „Die Belege sind nicht
ganz korrekt. Manchmal korrekt, manchmal hat er sich tausendmal
wiederholt an mehreren Stellen.“ Getestet mit einem exportierten
Lebenslauf (1 Seite, 4.251 pt hoch).

### Diagnose an den Rohdaten

Drei Fragen per `curl` gegen `POST /api/chat`, roher SSE-Stream
gespeichert (außerhalb des Repos, enthält personenbezogene Daten), dann
lokal durch `readUIMessageStream` und `ChatAnswer` gespielt.

- **UI unschuldig.** Pro Antwort genau ein `data-citations`- und ein
  Text-Part; `splitCitations` und die Keys liefern genau die `[n]` aus dem
  Stream.
- **Einlesen (Ursache).** `parsePdf` lieferte 29.458 Zeichen,
  `pdftotext` rund 20.000. 565 von 588 Textfenstern (100 Zeichen) kamen
  mehrfach vor. Zwei Mechanismen: 295 von 628 Textstücken waren
  deckungsgleich doppelt gezeichnet (gleiche Transform-Matrix), und der
  Abschnitt „Berufserfahrung“ lag ein zweites Mal 492 pt versetzt in der
  Textebene, im Bild nicht sichtbar. Ergebnis: 12 Chunks statt 5, 18
  Chunk-Paare zu über 60 % deckungsgleich, Höchstwert 92 %.
- **Retrieval (Folge).** Die Top 5 waren Kopien derselben Passage.
- **Prompt (Folge).** Regel 2 erlaubte beliebig viele Belege; das Modell
  hängte `[1][2][3][4][5]` an Zeilen, deren Angabe nur in einem Chunk
  stand. Zusätzlich Markdown (`**`), das das UI roh zeigt (24 Sternchen in
  einer Antwort).
- **Ausschnitt (Eindruck „falsch“).** Die Karte zeigte die ersten 240
  Zeichen eines Chunks von bis zu 2.880 Zeichen. Die zitierte Angabe stand
  im Chunk, aber nicht im Ausschnitt.

### Behebung (Branch `fix/belegqualitaet`)

| Commit | Inhalt | Rot ohne Fix |
| --- | --- | --- |
| `pdf: doppelt gezeichneten …` | `joinTextItems` verwirft gleiche Stücke an gleicher Stelle (1 pt Toleranz), `removeRepeatedBlocks` spätere wörtliche Kopien ab 500 Zeichen pro Seite, an Wortgrenzen. Neues Fixture `duplikate-beispiel.pdf` | beide Fixture-Tests rot (2 statt 1 Vorkommen); nach dem ersten Teil allein bleibt der Abschnitt-Test rot |
| `retrieval: fast gleiche Treffer …` | `dropNearDuplicates`: 5-Wort-Shingles, Überdeckung > 60 % mit einem besser platzierten Treffer **desselben** Dokuments, danach Auffüllen | PGlite-Test rot: dieselbe Stelle zweimal in den Treffern |
| `prompt: höchstens zwei Belege …` | Regel 2 begrenzt auf zwei tragende Belege, neue Regel 7 verbietet Markdown, Aufzählungen als Bindestrich-Zeilen. SHA-256-Test bewusst neu gesetzt, `REFUSAL_TEXT` unverändert. **Ändert das Produktversprechen, freigegeben von Leonardo am 10.11.2026** | zwei Inhaltstests rot |
| `prompt: Ausschnitt an der …` | `snippet()` wählt das Fenster mit den meisten verschiedenen Fragewörtern (Stoppwörter, Unicode-Wortgrenzen, Präfix für Beugung), 320 Zeichen, sonst Anfang | drei Snippet-Tests und der Chat-Test (Ausschnitt enthält „Kaution“) rot |

Gemessen am Lebenslauf, lokal mit dem neuen Code (Zahlen ohne Inhalt):

| | vorher | nachher |
| --- | --- | --- |
| Zeichen nach dem Einlesen | 29.458 | 10.591 |
| Chunks | 12 | 5 |
| Chunk-Paare > 60 % deckungsgleich | 18 | 0 |
| größte Überdeckung zweier Chunks | 92 % | 28 % |
| mehrfache Textfenster | 565 / 588 | 2 / 210 |

Textverlust geprüft: Von 2.940 Fenstern (60 Zeichen) des alten Texts
fehlen im neuen 17, alle an den Nahtstellen zwischen zwei Kopien.

Dieselben drei Fragen lokal (PGlite, echte Embeddings, `gpt-4o-mini`,
kein Production-Schreibzugriff):

| Frage | `[n]` vorher → nachher | größte Belegkette | `**` |
| --- | --- | --- | --- |
| Berufliche Stationen | 12 → 11 | 1 → 1 | 24 → 0 |
| Technologien | 20 → 8 | 5 → 2 | 16 → 0 |
| Ausbildung | 1 → 1 | 1 → 1 | 0 → 0 |

### Warum es keiner Rolle vorher auffiel

Alle Tests liefen gegen selbst erzeugte PDFs, in denen jeder Text genau
einmal gezeichnet ist. Der Tester prüfte „kein Textverlust“, aber nie „kein
Text zu viel“; der Reviewer las den Diff, nicht die Daten, die ein echter
Export liefert. Eine Kopie fällt erst auf, wenn man echte Stream-Rohdaten
mit `pdftotext` vergleicht.

### Offen

- Nach dem Merge muss der Lebenslauf gelöscht und neu hochgeladen werden;
  die gespeicherten Chunks sind noch die alten.
- Bei Listen hängt weiterhin ein `[1]` an jeder Zeile (Regel 7 verlangt
  das). Ob mehrere Zeilen aus derselben Quelle zusammengefasst werden
  sollen, ist eine Produktfrage.
- Gesperrte Überschriften wie „A U S B I L D U N G“ aus dem Export findet
  weder die Volltextsuche noch der Ausschnitt; dann bleibt der Ausschnitt
  am Anfang. Kandidat für die Textbereinigung.
- Der Ausschnitt richtet sich nach der Frage, nicht nach der zitierten
  Aussage. Besser wäre er an der Aussage, das geht aber erst nach dem
  Stream.
- Die Frage nach den Stationen nannte nachher eine Station weniger
  (11 statt 12); einzelner Lauf, im Eval in Schritt 4 nachprüfen.

### Testergebnis

`npm run typecheck`, `npm run lint`, `npm test` (220 Tests in 16 Dateien)
und `npm run build` grün auf dem Stand vor diesem Doku-Commit.
