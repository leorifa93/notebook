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
