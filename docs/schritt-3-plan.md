# Plan Schritt 3 — Chat mit Belegen

Ziel: Nach diesem Schritt stellt Leonardo im Notebook „Demo“ eine Frage zu den angehakten Quellen. Die Antwort kommt gestreamt, jede Aussage trägt einen Beleg `[n]`, und ein Klick auf den Beleg zeigt Ausschnitt und Seite und öffnet das Original-PDF auf genau dieser Seite. Steht die Antwort nicht in den Quellen, sagt Notebook das. Beim Öffnen steht eine kurze Zusammenfassung mit drei Fragevorschlägen da. Eval und README-Feinschliff bleiben Schritt 4.

**Status: Entwurf, wartet auf Freigabe durch Leonardo.** Rolle: `@architekt`. Kein Anwendungscode in diesem PR. Die Umsetzung beginnt erst nach Antwort auf die [offenen Entscheidungen](#offene-entscheidungen-für-leonardo).

Ausgangslage (Stand `main` nach PR #5): `POST /api/chat` validiert nur und antwortet `501`. `retrieve()` (Hybrid + RRF), `SYSTEM_PROMPT`, `buildUserPrompt()` und `buildCitations()` sind seit Schritt 1 vorbereitet, aber nie gegen echte Daten gelaufen. Installiert sind `ai@5.0.285` und `@ai-sdk/openai@2.0.140`; `@ai-sdk/react` fehlt.

---

## Entscheidungen

### 1. Belegliste als Data-Part vor dem Text, über `createUIMessageStream`

Die Route sucht zuerst, schreibt dann mit `writer.write({ type: "data-citations", data: citations })` die Belegliste in den Stream und hängt erst danach `streamText(…).toUIMessageStream()` per `writer.merge()` an; Antwort über `createUIMessageStreamResponse()`. So stehen die Karten, bevor das erste Wort kommt, und `[n]` im Text lässt sich sofort auflösen. Verworfen: `messageMetadata` aus dem Kommentar in `app/api/chat/route.ts` — Metadaten hängen am `start`/`finish`-Chunk und sind im Client weniger eindeutig zu typisieren als ein benannter Data-Part, der als Teil der Nachricht erhalten bleibt (nicht `transient`).

### 2. Client über `useChat` aus `@ai-sdk/react` (neue Abhängigkeit, Frage 1)

`useChat` mit `DefaultChatTransport({ api: "/api/chat", prepareSendMessagesRequest })` liest das SSE-Format von AI SDK 5, verwaltet Status (`submitted`/`streaming`/`error`), Abbruch (`stop()`) und typisierte Data-Parts. `prepareSendMessagesRequest` schickt nur `{ question, documentIds }`, nicht den ganzen Verlauf. Verworfen: eigener Reader mit `fetch` + `readUIMessageStream` aus `ai` — ginge ohne Paket, heißt aber SSE-Parsing, Abbruch und Fehlerzustände selbst schreiben; genau der Teil, der in der Live-Demo hakt. Version: `@ai-sdk/react@2.0.x` passend zu `ai@5.0.x`, exakt gepinnt wie die übrigen Pakete.

### 3. Jede Frage einzeln, kein Verlauf in der DB und nicht im Prompt (Frage 3)

Der Server bekommt nur die aktuelle Frage, sucht dazu und antwortet. Der Verlauf lebt im Browser-State und ist nach einem Reload weg. Begründung: Ein Verlauf im Prompt verwässert „nur aus den Quellen“ (das Modell zitiert dann seine eigene Vorantwort), und Folgefragen wie „und die Kaution?“ bräuchten eine Umformulierung der Suchanfrage — ein eigener LLM-Schritt. Verworfen: Tabelle `messages` — ohne Login gehört ein Verlauf niemandem, und für die Demo bringt er nichts.

### 4. Absage zweistufig: Schwelle vor dem Modell, Regel im Prompt (Frage 4)

Stufe 1 (neu, ohne Modellaufruf): `retrieve()` liefert zusätzlich `vectorSimilarity = 1 - (embedding <=> frage)` je Chunk. Ist die Liste leer oder liegt die beste Ähnlichkeit unter `MIN_SIMILARITY = 0.25`, antwortet die Route direkt mit dem Absagetext und leerer Belegliste. Stufe 2 (vorhanden): Regel 3 des Systemprompts für Fälle, in denen Treffer da sind, aber die Antwort fehlt. Der RRF-Score taugt dafür nicht, weil er nur Ränge addiert und immer einen „besten“ Treffer hat. Verworfen: nur den Prompt entscheiden lassen — kostet bei jeder Off-Topic-Frage einen Modellaufruf und ist schwer deterministisch zu testen. Die Schwelle ist ein Startwert; sie wird in Schritt 4 an D1–D3 und A1–A5 aus `docs/eval-plan.md` kalibriert.

Der Absagetext steht wörtlich in `SYSTEM_PROMPT` („Das steht nicht in den bereitgestellten Quellen.“). Er wird als Konstante `REFUSAL_TEXT` exportiert und im Prompt per Template eingesetzt; der Prompt-String bleibt Zeichen für Zeichen gleich (Test vergleicht ihn mit dem bisherigen Text). Das ist keine Änderung des Produktversprechens, wird aber im PR ausdrücklich so benannt.

### 5. Belegkarte als Popover, Sprung als neuer Tab auf `/api/documents/[id]/file#page=N`

`[n]` im Antworttext wird zu einem Button; Klick öffnet eine Karte mit Dokumenttitel, Seite und Ausschnitt (`snippet`, 240 Zeichen) und dem Link „Im Original öffnen, Seite N“. Neue Route `GET /api/documents/[id]/file` liefert `documents.file_bytes` mit `Content-Type` aus `mime_type`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`; Markdown und Text immer als `text/plain; charset=utf-8`, nie als HTML. `buildCitations()` setzt `href` auf diese Route plus `#page=N` (ohne Anker bei `page = null`). Verworfen: eingebetteter pdf.js-Viewer mit Hervorhebung — neues Paket, eigener Worker, mindestens eine Stunde; der Browser-Viewer kann `#page=` in Chrome, Edge und Firefox. Safari ignoriert den Anker, dort öffnet die Datei auf Seite 1 (im README als bekannte Grenze).

Antworten werden als Text mit Absätzen gerendert, ohne Markdown-Renderer. Ein Parser `splitCitations(text, count)` zerlegt in Text- und Belegstücke; `[n]` außerhalb der Belegliste bleibt sichtbarer Text mit Warnmarkierung statt toter Button. Verworfen: `react-markdown` — weiteres Paket, und Listen/Fettdruck sind für belegte Kurzantworten verzichtbar.

### 6. Zusammenfassung und drei Fragevorschläge pro Quellenstand, gecacht in Postgres (Frage 2)

Erzeugt wird lazy: Der Client fragt nach dem Laden der Quellen `GET /api/summary`. Passt der Cache zum aktuellen Quellenstand, kommt er sofort; sonst `{ stale: true }`, und der Client stößt `POST /api/summary` an. Quellenstand = SHA-256 über die sortierten `content_sha256` aller Dokumente im Notebook; ein Upload oder Löschen macht den Cache damit automatisch ungültig. Gespeichert in einer neuen Tabelle `notebook_summaries (notebook_id PK, sources_key, summary, citations jsonb, questions jsonb, model, created_at)`, RLS an wie bei allen Tabellen. Eingabe sind die ersten Chunks jedes Dokuments (gleichmäßig verteilt, zusammen höchstens ~6.000 Tokens), keine Suche. Ausgabe über `generateObject` mit `jsonSchema()` aus `ai` (kein `zod` als neue direkte Abhängigkeit): `{ summary, questions[3] }`; die Zusammenfassung belegt mit `[n]` wie der Chat, damit Architekturregel 2 auch hier gilt.

Verworfen: Zusammenfassung pro Dokument beim Ingest — verlängert jeden Upload um einen Modellaufruf (Ingest liegt schon nahe an `maxDuration`), und NotebookLM fasst das Notebook zusammen, nicht die Datei. Verworfen: Zusammenfassung über die *angehakten* Quellen — jedes Häkchen würde den Cache sprengen.

Dafür braucht es einen zweiten, kurzen Prompt `SUMMARY_SYSTEM_PROMPT` in `lib/prompt.ts` (Ergänzung, `SYSTEM_PROMPT` bleibt unverändert). Weil das das Produktversprechen berührt, ist er Teil von Frage 2.

### 7. Rate-Limit am Chat und an der Zusammenfassung mit der vorhandenen Hilfsfunktion

`CHAT_RATE_LIMIT = { endpoint: "chat", limit: 20, windowSeconds: 900 }` und `SUMMARY_RATE_LIMIT = { endpoint: "summary", limit: 6, windowSeconds: 900 }` in `lib/rate-limit.ts`, verdrahtet mit `consumeRateLimit()` nach der Body-Validierung und vor Embedding und Modell — wie beim Ingest. Gezählt wird beim Chat jede angenommene Frage (auch eine Absage, sie kostet ein Embedding), bei der Zusammenfassung nur ein Cache-Miss. Verworfen: ein gemeinsames Kontingent für alles — ein Upload-Test würde sonst den Chat in der Demo sperren.

### 8. Konfigurationsfehler sind kein „versuch es gleich nochmal“

Neue Klasse `ConfigError` in `lib/env.ts`, geworfen von `databaseUrl()` und `openAiApiKey()`. Dazu eine kleine Zuordnung `classifyUpstreamError()` für `APICallError` des AI SDK: `401/403` (falscher Key, wie live mit dem `key_`-Wert passiert) gilt als Konfiguration, `429` mit `insufficient_quota` als aufgebrauchtes Guthaben, `5xx`/Timeout als vorübergehend. Nur der letzte Fall darf zum erneuten Versuch raten. Gilt für Chat, Zusammenfassung **und** den bestehenden Ingest (schließt R8 aus `docs/review-schritt-2.md`). Verworfen: das nur im Chat lösen — dann sagt der Upload weiter das Falsche.

### 9. Retrieval wird testbar und auf das Notebook begrenzt

`retrieve()` bekommt wie der Ingest ihre Abhängigkeiten übergeben (`{ db: Queryable, embed }`) statt `query()` und `embedQuery()` direkt zu importieren; nur so läuft der Chat-Pfad gegen PGlite. Die Route schneidet die gesendeten `documentIds` mit den Dokumenten des Notebooks „Demo“; fremde oder kaputte IDs fallen heraus. Eine leere Auswahl wird **nicht** mehr als „alle Dokumente“ gelesen (heute `documentIds: [] → NULL → alles`), sondern mit 400 abgelehnt. Verworfen: `notebook_id` in `HYBRID_SQL` filtern — braucht einen Join in beiden Teilabfragen, während die Schnittmenge ohnehin für die UUID-Prüfung nötig ist.

---

## Grenzen und Kosten

| Größe | Wert | Warum |
| --- | --- | --- |
| Fragelänge | 2.000 Zeichen (wie heute) | bestehender Test bleibt gültig; reicht für jede echte Frage |
| Kandidaten je Liste | 20 | vorhandener Default in `lib/retrieval.ts` |
| topK (Belege) | 5 | vorhandener Default; Eval misst Recall@5 |
| Kontext | ≤ 5 × 800 Tokens ≈ 4.000 + Systemprompt ~350 + Frage ≤ ~550 | Chunk-Maximum aus `lib/chunk.ts` |
| `maxOutputTokens` Chat | 700 | belegte Kurzantworten; schneidet nichts Sinnvolles ab |
| `temperature` | 0.1 | wie im vorbereiteten Kommentar |
| `maxRetries` | 1 | ein Retry ja, aber nicht drei innerhalb von 60 s |
| Timeout | `AbortSignal.any([request.signal, AbortSignal.timeout(45_000)])` | bleibt unter `maxDuration = 60` (Hobby-Maximum) und bricht ab, wenn der Nutzer `stop()` drückt |
| Zusammenfassung | Eingabe ≤ ~6.000 Tokens, `maxOutputTokens` 500 | ein Aufruf pro Quellenstand |
| Originaldatei | ≤ 4 MB (Ingest-Limit) | unter dem Antwortlimit von Vercel (~4,5 MB) |

Kosten mit `gpt-4o-mini` (0,15 $ / 1 M Input, 0,60 $ / 1 M Output): eine Frage ≈ 5.000 × 0,15 + 700 × 0,60 ≈ **0,0012 $**, eine Zusammenfassung ≈ 6.000 × 0,15 + 500 × 0,60 ≈ **0,0012 $**; das Frage-Embedding ist vernachlässigbar. Eine Absage aus Stufe 1 kostet nur das Embedding. Mit 20 Fragen je 15 Minuten und IP kommen die 5 $ Guthaben auch bei Missbrauch nicht in einer Demo-Woche an ihr Ende.

---

## Fehlerfälle und Meldungen

Vor dem Stream als JSON mit Status, im Stream über `onError` von `createUIMessageStream` (sonst gibt das SDK nur „An error occurred.“ weiter). Keine Stacktraces, `console.error` mit Kontext wie beim Ingest.

| Fall | Status | Meldung |
| --- | --- | --- |
| Body kein JSON | 400 | „Body ist kein gültiges JSON.“ (vorhanden) |
| Frage leer / zu lang | 400 | vorhanden |
| Keine gültige Quelle ausgewählt | 400 | „Wähle mindestens eine Quelle aus, damit Notebook antworten kann.“ |
| Rate-Limit | 429 + `Retry-After` | „Zu viele Fragen in kurzer Zeit. Bitte versuche es in N Minuten erneut.“ |
| `DATABASE_URL`/`OPENAI_API_KEY` fehlt, Key abgelehnt (401/403) | 503 | „Notebook ist gerade nicht vollständig eingerichtet. Ein erneuter Versuch hilft nicht – bitte gib dem Betreiber Bescheid.“ |
| Guthaben aufgebraucht (`insufficient_quota`) | 503 | „Das Kontingent des Demo-Schlüssels ist aufgebraucht. Ein erneuter Versuch hilft nicht.“ |
| OpenAI 5xx / Netz | 502 | „Die Antwort konnte gerade nicht erzeugt werden. Bitte versuche es in einem Moment erneut.“ |
| Datenbank bei der Suche | 500 | „Die Quellen konnten gerade nicht durchsucht werden. Bitte versuche es erneut.“ |
| Timeout (45 s) im Stream | — | „Die Antwort hat zu lange gedauert. Bitte stelle die Frage enger oder wähle weniger Quellen.“ |
| Abbruch mitten im Stream | — | „Die Antwort ist abgebrochen. Bitte stelle die Frage erneut.“ |
| Datei: ungültige ID | 400 | „Ungültige Dokument-ID.“ |
| Datei: nicht vorhanden | 404 | „Die Quelle gibt es nicht (mehr).“ |
| Datei: Zeile ohne `file_bytes` (vor Schritt 2) | 404 | „Für diese Quelle ist keine Originaldatei gespeichert.“ |
| Zusammenfassung: Modell liefert unbrauchbares JSON | 200, `summary: null` | UI: „Zusammenfassung gerade nicht verfügbar.“ Chat bleibt nutzbar. |

Ingest übernimmt die 503-Meldungen für Konfiguration und Guthaben; die 502-Meldung „Bitte versuche es gleich noch einmal“ bleibt nur für echte vorübergehende Fehler.

---

## Aufgaben / Commits

Reihenfolge nach Freigabe, jeder Commit einzeln reviewbar und mit eigenen Tests; `typecheck`, `lint`, `test`, `build` nach jedem grün.

1. `plan: Schritt 3 Chat mit Belegen` — dieses Dokument (erledigt).
2. `env: Konfigurationsfehler von vorübergehenden Fehlern trennen` — `ConfigError`, `classifyUpstreamError()`, Ingest-Meldungen (R8).
3. `retrieval: Abhängigkeiten übergeben und Vektor-Ähnlichkeit mitliefern` — `{ db, embed }`, Spalte `vector_similarity` in `HYBRID_SQL`, PGlite-Test.
4. `prompt: Belege verlinken und Quellenblöcke gegen Fremdtext absichern` — `href` auf `/api/documents/[id]/file#page=N`, Escaping von Titel und `</quelle>` im Chunk-Text, Kürzung nicht unter Chunk-Maximum, `REFUSAL_TEXT` exportiert (Prompt-String unverändert, per Test belegt). Veralteten `TODO(Schritt 2)` zu `sourcePath` entfernen.
5. `api: Originaldatei für den Seitensprung ausliefern` — `GET /api/documents/[id]/file`, Header, 400/404.
6. `chat: Frage suchen und Antwort mit Belegliste vorweg streamen` — `handleChat(request, deps)` + Route, `documentIds` ∩ Notebook, leere Auswahl 400, Steuerzeichen aus der Frage entfernen, Timeout, Fehler-Mapping. Chat-501-Tests werden bewusst umgeschrieben.
7. `chat: Absage ohne Modellaufruf, wenn keine Quelle passt` — `MIN_SIMILARITY`, Absage als Text-Part mit leerer Belegliste.
8. `api: Rate-Limit pro IP für den Chat` — `CHAT_RATE_LIMIT`, 429, löst den `TODO(Schritt 3)` in `lib/rate-limit.ts`.
9. `chore: @ai-sdk/react für den Chat-Client` — nur bei Freigabe von Frage 1, begründet im PR.
10. `ui: Chatverlauf mit Streaming und klickbaren Belegen` — `ChatPlaceholder` → `Chat`, `useChat`, `selectedIds` als `documentIds`, Zustände leer/sendet/streamt/Fehler, Stop-Button, `splitCitations()`.
11. `ui: Belegkarte mit Ausschnitt, Seite und Sprung ins Original` — Popover, Tastatur (Enter/Escape), schmales Fenster.
12. `db: Cache für Zusammenfassung und Fragevorschläge` — `notebook_summaries`, idempotent, RLS.
13. `api: Zusammenfassung und Fragevorschläge pro Quellenstand` — `GET`/`POST /api/summary`, `SUMMARY_SYSTEM_PROMPT`, `generateObject` + `jsonSchema()`, `SUMMARY_RATE_LIMIT`.
14. `ui: Zusammenfassung und Vorschläge im leeren Chat` — ersetzt die drei festen Beispielfragen; Vorschlag anklicken = Frage senden.
15. `test: unsaubere Eingaben im Chat-Pfad bis in die Datenbank` — siehe Testplan, Lehre aus L1.
16. `docs: README und Review auf Stand Schritt 3` — Redakteur; `docs/review-schritt-3.md` entsteht durch den Reviewer.

---

## Testplan

**Gegen PGlite, Stub-Embeddings (`tests/helpers/embeddings.ts`) und `MockLanguageModelV2` aus `ai/test`** (geprüft: `ai@5.0.285` exportiert `MockLanguageModelV2`, `simulateReadableStream`, `convertReadableStreamToArray`). Der Handler bekommt das Modell als Abhängigkeit (`deps.model`), die Route verdrahtet `createOpenAI(...)(chatModelId())`.

- Reihenfolge: Im SSE-Body steht `data-citations` vor dem ersten `text-delta`; die Belegliste hat Titel, Seite, Ausschnitt und `href` mit `#page=`.
- Auswahl: Ein abgewähltes Dokument taucht nie in den Belegen auf; leere Auswahl → 400; fremde und kaputte IDs werden ignoriert (heute würde `"a"` den Cast `$3::uuid[]` mit 500 sprengen).
- Absage: Frage ohne gemeinsame Wörter mit dem Korpus → Absagetext, leere Belegliste, `doStream` des Mock-Modells **nicht** aufgerufen.
- Prompt: Der übergebene Prompt enthält genau die fünf Quellenblöcke in Rangfolge; `SYSTEM_PROMPT` ist byte-gleich zum bisherigen Text.
- Rate-Limit: 21. Frage derselben IP → 429 mit `Retry-After`.
- Fehler: `embed` wirft `ConfigError` → 503 ohne „erneut“; Mock-Modell wirft mitten im Stream → Fehler-Chunk mit deutscher Meldung, kein Stacktrace.
- Datei-Route: Bytes identisch zur Fixture, `Content-Type`, `nosniff`, Markdown als `text/plain`, 404 für fremde ID.
- Zusammenfassung: Mock-`doGenerate` liefert JSON → Cache geschrieben; zweiter `GET` ruft das Modell nicht; nach Upload oder Löschen `stale`; kaputtes JSON → `summary: null`, kein 500.
- `splitCitations()`: `[1][2]`, `[12]`, `[7]` bei fünf Belegen, `[a]`, Text ohne Belege.
- **Unsauberer Input (L1-Lehre):** Frage mit `\u0000` und anderen Steuerzeichen läuft durch Embedding **und** `plainto_tsquery` gegen PGlite, ohne `invalid byte sequence` (ohne Bereinigung schlägt der Test fehl — erst gegen den alten Stand laufen lassen). Ein Chunk mit `</quelle>` und „Ignoriere alle Regeln“ sowie ein Titel mit `"` ergeben weiterhin genau fünf wohlgeformte Quellenblöcke.

**Nur live (Vercel-Preview, echte Keys):** Antwortqualität von `gpt-4o-mini`, Streaming ohne Pufferung durch die Plattform, `#page=`-Sprung in Chrome und Firefox, Laufzeit unter 45 s, Absage bei D1–D3 aus dem Eval-Plan mit echten Embeddings (Kalibrierung der Schwelle in Schritt 4).

---

## Abnahmekriterien

- Frage zu angehakten Quellen → erster Text in unter 2 s im Preview; Belegkarten stehen, bevor der Text beginnt.
- Jede inhaltliche Aussage der Antwort hat `[n]`; jeder `[n]` öffnet eine Karte mit Titel, Seite und Ausschnitt. „Im Original öffnen“ zeigt das PDF auf der Seite des Belegs (Chrome).
- Eine abgewählte Quelle wird nie zitiert. Keine Quelle angehakt → Senden deaktiviert und serverseitig 400.
- „Wie hoch ist die Miete für die Garage?“ auf dem Mietvertrag → „Das steht nicht in den bereitgestellten Quellen.“ ohne erfundene Zahl und ohne Belege.
- Nach dem ersten Upload erscheinen Zusammenfassung (mit Belegen) und drei Fragevorschläge; ein Reload liest sie aus dem Cache (kein zweiter Modellaufruf im Log); Upload oder Löschen erneuert sie.
- 21. Frage in 15 Minuten → 429 mit Minutenangabe. Fehlender oder falscher Key → Meldung ohne „versuch es erneut“, beim Chat **und** beim Upload.
- `npm run typecheck`, `lint`, `test`, `build` grün ohne `DATABASE_URL` und `OPENAI_API_KEY`. Die alten Chat-501-Tests sind umgeschrieben, nicht gelöscht.
- Kein Secret im Diff; neue Pakete nur `@ai-sdk/react` (falls freigegeben), im PR begründet. `SYSTEM_PROMPT` unverändert.

---

## Nicht-Ziele (bewusst in diesem Schritt draußen)

- Chatverlauf in der Datenbank, Folgefragen mit Kontext, Umformulieren der Suchanfrage.
- Eigener PDF-Viewer mit Hervorhebung der Fundstelle; Seitensprung in Safari.
- Markdown-Rendering der Antwort, Export, Kopieren als Zitat.
- Rerank (Cross-Encoder): `retrieveAndRerank()` bleibt bis Schritt 4 identisch zu `retrieve()`; ob es kommt, entscheidet das Eval.
- Mehrere Notebooks, Notebook-Umschalter, Teilen, Login, Audio/TTS, OCR, eigene Vektordatenbank, Wechsel von Embedding- oder Chatmodell.
- Eval-Runner und Kalibrierung von `MIN_SIMILARITY` (Schritt 4).

---

## Auffälligkeiten im bestehenden Code (benannt, nicht geändert)

1. **Leere Auswahl heißt heute „alle Dokumente“.** `retrieve()` macht aus `documentIds: []` ein `NULL` und sucht notebookübergreifend. Wer alle Häkchen entfernt, bekäme trotzdem Antworten. → Entscheidung 9, Commit 6.
2. **Nicht-UUID-IDs führen zu 500.** Die Chat-Route filtert nur Nicht-Strings; `"a"` landet im Cast `$3::uuid[]`. Der bestehende Test „filtert ungültige documentIds“ prüft genau diesen Fall mit `"a"` und `"b"`, nur weil die Route noch vor der Suche mit 501 aussteigt. → Commit 6.
3. **Prompt kürzt Chunks.** `buildUserPrompt()` schneidet Chunk-Text bei 2.400 Zeichen; Chunks dürfen laut `lib/chunk.ts` bis 800 Tokens × 3,6 ≈ 2.880 Zeichen lang sein. Das Ende großer Chunks sähe das Modell nie — derselbe Effekt, den Architekturregel 5 beim Speichern verbietet. → Commit 4.
4. **Quellenblöcke sind nicht escaped.** Titel landen ungeprüft in `dokument="…"`, Chunk-Text mit `</quelle>` beendet den Block vorzeitig. Ein hochgeladenes Dokument kann so Struktur und Anweisungen in den Prompt schmuggeln. → Commit 4, Test in Commit 15.
5. **`retrieve()` ist nicht gegen PGlite testbar**, weil es `query()` aus `lib/db.ts` direkt nutzt; nur `HYBRID_SQL` ist bisher getestet. → Commit 3.
6. **`buildCitations()` setzt `href` immer auf `null`** und trägt einen veralteten `TODO(Schritt 2)` zu einer Spalte `sourcePath`, die es nie gab (die Datei liegt in `file_bytes`). → Commit 4.
7. **Frage ohne Bereinigung.** Steuerzeichen in der Frage gingen ungefiltert in `plainto_tsquery` — dieselbe `0x00`-Falle wie L1, diesmal über das Eingabefeld. → Commit 6, Test in Commit 15.
8. **`@ai-sdk/react` fehlt**, obwohl der Route-Kommentar mit `toUIMessageStreamResponse` schon das Protokoll von `useChat` voraussetzt. → Frage 1.

---

## Offene Entscheidungen für Leonardo

1. **Neue Abhängigkeit `@ai-sdk/react` für `useChat`?** Empfehlung: **ja**, `2.0.x` passend zu `ai@5.0.x`, exakt gepinnt. Spart den eigenen SSE-Reader samt Abbruch und Fehlerzuständen; Alternative ist `fetch` + `readUIMessageStream` aus `ai` ohne neues Paket, kostet etwa eine Stunde mehr und ist fehleranfälliger.
2. **Zusammenfassung und Vorschläge lazy pro Quellenstand, gecacht in `notebook_summaries`, mit neuem `SUMMARY_SYSTEM_PROMPT`?** Empfehlung: **ja**. Kein längerer Upload, ein Modellaufruf je Quellenstand (≈ 0,001 $), Belege `[n]` auch in der Zusammenfassung. Alternative: pro Dokument beim Ingest.
3. **Jede Frage einzeln, ohne Verlauf im Prompt?** Empfehlung: **ja**. Hält „nur aus den Quellen“ sauber und spart einen Umformulierungs-Schritt; Folgefragen müssen dann vollständig gestellt werden („Wie hoch ist die Kaution?“ statt „und die Kaution?“). Alternative: die letzten zwei Runden mitschicken plus Umformulierung der Suchanfrage (+1 Modellaufruf pro Frage).
4. **Absage vor dem Modell bei bester Ähnlichkeit unter 0,25?** Empfehlung: **ja**, als Startwert, Kalibrierung in Schritt 4 am Eval. Deterministisch testbar und spart Kosten bei Off-Topic-Fragen; Risiko: zu hohe Schwelle verweigert berechtigte Fragen — deshalb bleibt Regel 3 im Prompt als zweite Stufe und die Schwelle eine benannte Konstante.
