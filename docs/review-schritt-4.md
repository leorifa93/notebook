# Review Schritt 4a: Eval

Basis: `main` bei `bfb9084`, Branch `feature/eval`. Plan:
[`docs/eval-plan.md`](eval-plan.md). Ergebnis:
[`eval/ergebnisse.md`](../eval/ergebnisse.md).

Vor jedem Commit liefen `@tester` und `@reviewer` gegen den gestagten Diff,
danach der Pre-commit-Hook (typecheck, lint, Tests). Kein `--no-verify`.

## Commits

| Commit | Inhalt | Tester (rot-grün) |
| --- | --- | --- |
| `fixtures: Produkthandbuch …` | zweites Dokument aus dem Plan (B2, B3, Injection), per `generate.py`; die bestehenden PDFs bleiben byte-gleich | Parser-Test für Seiten 4, 5, 6 war ohne die Datei rot |
| `eval: Metriken …` | reine Funktionen in `eval/metrics.ts`, 12 Tests | Mutation der Satztrennung (Tausenderpunkt) machte einen Test rot |
| `eval: Fragen-Set und Runner …` | `eval/questions.json` (19 Fragen), `eval/run.ts`, `npm run eval`, Rang-Metrik | Rang-Test; Probelauf mit `--runs 1` |
| `eval: Ergebnisse …` | `eval/ergebnisse.md`, Rohdaten eines Laufs (73 kB), weitere Läufe in `.gitignore` | drei Läufe, Median |
| `docs: …` | README-Abschnitt Eval, Grenzen, TODOs aus Schritt 4 entschieden | nur Kommentare und Doku |

## Abweichungen vom Plan (vor dem Lauf festgelegt)

- **B2, B3 präziser.** „das Ersatzteil“ und „des Filters“ wären im neuen
  Handbuch mehrdeutig; die Fragen nennen jetzt Vorfilter-Gitter und
  HEPA-Filter. Seiten 5 und 6 wie im Plan.
- **A3, B4 mit Seiten 3 oder 6.** Die Kündigungsfrist steht im Fixture auf
  beiden Seiten (Anforderung „eine Information auf zwei Seiten“), der
  Parser-Test prüft das seit Schritt 2.
- **Neu: O1–O3 und I1.** Fragen ganz ohne Bezug, um Stufe 1 der Absage zu
  kalibrieren (die D-Fragen liegen im Thema), und die Injection-Frage aus
  der Notiz im Plan.
- **„Antwort ok“ per Muster** statt manueller Prüfung: Kernzahl oder
  Bezeichner muss in der Antwort stehen; Absagen dürfen keine erfundene
  Angabe enthalten (`forbid`, Bewertungsregel 3).

## Befunde aus den Reviews vor den Commits

| Nr | Schweregrad | Befund | Entscheidung |
| --- | --- | --- | --- |
| R1 | hinweis | `eval/run.ts` importiert Hilfen aus `tests/helpers/` (PGlite, Fixtures, SSE-Parser) | akzeptiert: dieselbe Datenbank wie die Tests, keine Kopie |
| R2 | hinweis | `vite-node` ist keine direkte Abhängigkeit, sondern kommt mit `vitest` | akzeptiert: kein neues Paket; es löst den `@/`-Alias aus `vitest.config.ts` |
| R3 | hinweis | `process.loadEnvFile(".env.local")` liest außerhalb von `lib/env.ts` | akzeptiert: füllt nur `process.env`, gelesen wird weiter über `lib/env.ts`; der Key wird nie ausgegeben |
| R4 | hinweis | Das Rate-Limit wird vor jeder Frage in der lokalen PGlite geleert | akzeptiert: nur lokal, sonst bremst die 21. Frage das Eval |
| R5 | hinweis | Embedding-Tokens sind geschätzt (Zeichen / 4) | akzeptiert und in den Ergebnissen benannt; Chat-Tokens sind gemessen |

Keine Änderung am Systemprompt, an `MIN_SIMILARITY` oder an Produktlogik.

## Entschieden

- **Schwelle 0,25 bleibt** (Zahlen und Begründung in
  `eval/ergebnisse.md`). Eine Anhebung auf etwa 0,30 wäre eine eigene
  Entscheidung von Leonardo, besser nach einer Messung an echten Dokumenten.
- **Kein Rerank:** Rang 1 in 13 von 13 Fragen.
- **Kein „unbelegt“-Hinweis:** als Grenze im README; im Eval 0 von 57.

## Offen

- Der Korpus ist klein und synthetisch; ein Eval an einem echten Export
  (ohne Nutzerdaten im Repo) fehlt.
- I1 prüft nur, dass die Anweisung nicht wirkt, nicht, dass das Modell den
  Satz auf Nachfrage wörtlich zitiert.
