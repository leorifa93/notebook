# AGENTS.md

Regeln für KI-Assistenten, die in diesem Repository arbeiten. Ziel ist, dass
jede Änderung aussieht, als hätte sie ein Mensch mit einem Plan gemacht — und
nicht wie ein generierter Dump. Wenn eine Anweisung hier einer allgemeinen
Gewohnheit widerspricht, gilt diese Datei.

## Stack (verbindlich)

- **Next.js 15** mit App Router. Kein `pages/`-Verzeichnis.
- **TypeScript**, `strict` plus `noUncheckedIndexedAccess`. Kein `any`.
- **Tailwind CSS 3** mit den Design-Tokens aus `app/globals.css`. Keine
  Inline-Styles, keine zweite Styling-Bibliothek.
- **shadcn/ui** als handgeschriebene Dateien in `components/ui/`. Komponenten
  bei Bedarf ergänzen, nicht per CLI-Interaktivprompt erzeugen.
- **Vercel AI SDK** (`ai`, `@ai-sdk/openai`) für Embeddings und Chat.
- **Supabase (Postgres + pgvector)**, Zugriff ausschließlich über `pg` mit rohem
  SQL gegen den Supabase-Pooler. Kein ORM, keine zweite Datenhaltung.
  **Kein Prisma, kein Drizzle, kein anderes ORM.** Die Suche braucht
  `<=>`, `ts_rank_cd` und `FULL OUTER JOIN` — ein ORM stünde dem nur im Weg.
- Deployment-Ziel ist **Vercel**.

Neue Abhängigkeit? Erst prüfen, ob die vorhandenen es können. Jedes Paket muss
im Pull Request begründet werden.

## Wo was hingehört

```
app/
  api/ingest/route.ts   Upload: validieren → parse → chunk → embed → insert
  api/chat/route.ts     Frage: retrieve → prompt → stream
  page.tsx, layout.tsx  UI
components/
  ui/                   shadcn-Primitives, generisch, ohne Fachlogik
  *.tsx                 Fachkomponenten (Sidebar, Chat, Belegkarte)
lib/
  db.ts                 einziger Ort mit `pg`
  pdf.ts                PDF → Seiten
  text.ts               Textbereinigung ohne Abhängigkeiten (auch im Chat)
  chunk.ts              Seiten → Chunks
  embeddings.ts         Text → Vektor
  retrieval.ts          Frage → Kandidaten
  prompt.ts             Kandidaten → Prompt, Belege
  env.ts                alle Env-Zugriffe
db/schema.sql           Schema, idempotent
docs/                   Konzepte, keine Implementierung
eval/                   Eval-Set (JSON) und Runner
```

## Architekturregeln

1. **Jede Antwort stammt ausschließlich aus den Quellen.** Der Systemprompt in
   `lib/prompt.ts` ist die einzige Wahrheit dazu. Wer ihn ändert, ändert das
   Produktversprechen und muss das im PR begründen.
2. **Jede inhaltliche Aussage braucht einen Beleg** im Format `[n]`. Eine
   Antwort ohne Beleg ist ein Bug, nicht eine Stilfrage.
3. **Steht etwas nicht in den Quellen, wird das gesagt.** Kein Ausweichen auf
   Vorwissen des Modells, auch nicht bei "offensichtlichen" Fragen.
4. **Seitenzahlen dürfen nicht verloren gehen.** Ein Chunk gehört genau einer
   Seite. `mergePages: true` beim PDF-Parsing ist verboten — es zerstört die
   Belegfähigkeit.
5. **Chunks werden nie abgeschnitten.** Lieber einen zu großen Chunk als
   verlorenen Text; fehlender Text ist im Chat unsichtbar.
6. **Server-Code nur in `app/api/**` und `lib/`.** Keine Datenbankzugriffe in
   Client-Komponenten, keine Secrets in `NEXT_PUBLIC_*`.
7. **Env-Zugriffe nur über `lib/env.ts`**, immer lazy. `next build` muss ohne
   Keys durchlaufen.
8. **Fehler klar melden.** Ein Endpoint, der noch nicht implementiert ist,
   antwortet `501` mit Begründung — nicht `200` mit leerem Ergebnis.

## Coding-Konventionen

- `const` vor `let`. Keine Default-Exports außer in Next.js-Konventionen
  (`page.tsx`, `layout.tsx`, `route.ts`).
- Typen explizit an Modulgrenzen; Rückgabetypen von Funktionen ausschreiben.
- Kommentare erklären **warum**, nicht **was**. Ein Kommentar, der den Code
  nacherzählt, wird gelöscht.
- Deutsche UI-Texte, deutsche Kommentare, englische Bezeichner im Code.
- Fehlermeldungen an Nutzer auf Deutsch und ohne Stacktrace.
- Keine `console.log`-Debug-Ausgaben im finalen Stand; `console.error` nur für
  echte Fehler mit Kontext.

## Nicht-Ziele (nicht bauen, auch nicht "schnell")

- Keine Authentifizierung, keine Sessions, keine Nutzerkonten.
- Keine Audio-Overview, kein TTS, keine Podcast-Generierung.
- Keine Multi-User-Verwaltung, kein Teilen, keine Rollen.
- Keine eigene Vektordatenbank.
- Kein OCR für gescannte PDFs (erkennen und ablehnen genügt).
- Kein Wechsel des Embedding-Modells ohne Schema-Migration.

Wenn eine Aufgabe eines dieser Felder berührt: nicht umsetzen, sondern im PR
benennen und Rücksprache halten.

## Definition of Done

Vor jedem Commit erzwingt der Pre-commit-Hook:

```bash
npm run typecheck
npm run lint
npm test
```

Alle drei müssen grün sein. `--no-verify` ist verboten.

Zusätzlich, bevor der Commit entsteht:

- Der Umsetzer ruft `@tester` auf: ein passender Test ist vorhanden und
  der rot-grün-Weg nachvollziehbar.
- Der Umsetzer ruft `@reviewer` auf: die Checkliste läuft gegen den
  gestagten Diff.
- Offene Befunde werden vor dem Commit behoben, nicht auf das
  Schrittende verschoben.
- Kein `.env`-Inhalt, kein Key, kein Token im Diff.
- Neue Funktionen haben mindestens einen Aufrufer oder einen klaren `TODO`
  mit Schritt-Nummer.
- README aktualisiert, wenn sich Setup oder Architektur ändern.

`npm run build` läuft in der CI und vor der Abnahme eines Schritts.

## Commit-Stil

Kleine, sprechende Commits. Ein Commit = eine Änderung, die man in einem Satz
erklären kann.

```
ingest: parse PDFs seitenweise und speichere Seitenzahl am Chunk
retrieval: fusioniere Vektor- und Volltextsuche per RRF
docs: Architekturentscheidungen im README begründen
```

Kein `initial commit` mit 4000 Zeilen, kein `fix`, kein `wip`.
