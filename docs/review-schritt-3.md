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
