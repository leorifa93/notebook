# Review Schritt 1 — Grundgerüst

Diese Datei ist das Protokoll des Review-Durchgangs zu Schritt 1. Sie hält fest,
was geprüft wurde, was dabei gefunden wurde und was bewusst offen bleibt. Ein
Schritt gilt erst als abgenommen, wenn diese Liste abgearbeitet ist.

## Umfang von Schritt 1

Projekt-Setup, Tailwind-Konfiguration, App-Shell, Datenmodell, die
Pipeline-Bausteine als reine Funktionen (Parsing, Chunking, Embeddings,
Retrieval, Prompt) und das API-Gerüst. Kein Upload, kein Chat, keine
Datenbankverbindung im Betrieb.

## Geprüft

| Prüfpunkt | Wie geprüft | Ergebnis |
| --- | --- | --- |
| Build ohne Secrets | `npm run build` in frischem Klon, ohne `.env.local` | grün |
| Typen | `npm run typecheck` (`tsc --noEmit`) | grün |
| Lint | `npm run lint` | grün |
| Schema läuft | `db/schema.sql` gegen echtes Postgres 18 mit pgvector | alle Tabellen, Indizes und Cascade angelegt |
| Schema idempotent | Skript zweimal hintereinander ausgeführt | zweiter Lauf fehlerfrei |
| Seitenzuordnung | echtes 3-seitiges PDF geparst | „Mietobjekt" → Seite 1, „Kaution" → Seite 2, „Kündigungsfrist" → Seite 3 |
| Chunking ohne Textverlust | Absatz über der Längengrenze | nach Fix kein Zeichenverlust |
| Hybridsuche | Testdaten mit bekannter Zielstelle | richtiger Chunk auf Platz 1 |
| API-Verhalten | Aufruf der Stub-Routen | 501 für Stubs, 400 bei ungültiger Eingabe |
| Oberfläche | Startseite in Desktop- und Mobilbreite gerendert | beide Zustände sauber |

## Gefundene Fehler

Beide Fehler waren still: Sie hätten in einer Demo nicht nach Fehler
ausgesehen, sondern nach einer schlechten Antwort.

**1. Volltextsuche verknüpfte alle Wörter mit UND.**
`websearch_to_tsquery` verbindet Suchbegriffe mit UND. Eine normale Frage wie
„Welche Fristen nennt das Dokument?" trifft damit fast nie einen Chunk, weil
alle Wörter gemeinsam im selben Chunk stehen müssten. Die Volltext-Hälfte der
Hybridsuche war dadurch praktisch wirkungslos — und weil die Vektorsuche
weiterhin Ergebnisse lieferte, fiel es nicht auf. Behoben durch ODER-Verknüpfung
der Begriffe; der Zielchunk landet seitdem mit dem korrekten Rang auf Platz 1.

**2. Chunking schnitt überlange Absätze ab.**
Ein einzelner Absatz über der Maximallänge wurde nicht aufgeteilt, sondern
verworfen. Im Test verschwanden 827 Wörter — unsichtbar, weil das Dokument
trotzdem als erfolgreich verarbeitet galt und nur dieser Inhalt fehlte. Behoben:
überlange Absätze werden jetzt an Satzgrenzen geteilt, es geht kein Text
verloren.

## Bewusst offen (und warum)

- **Kein OCR.** Gescannte PDFs werden erkannt und offen abgelehnt, nicht
  stillschweigend leer verarbeitet. Ein OCR-Dienst wäre ein zusätzlicher
  Anbieter und zusätzliche Latenz.
- **Keine Authentifizierung.** Die Demo ist offen. Begründung in der README
  unter „Bewusste Nicht-Ziele".
- **Kein Reranking.** In Schritt 1 ist es konzeptionell vorgesehen, aber noch
  nicht aktiv; die Fusion per RRF reicht für den Korpus dieser Größe.
- **Nur ein Embedding-Modell.** `vector(1536)` ist fest im Schema. Ein Wechsel
  wäre eine Migration plus Re-Embedding, nicht eine Env-Änderung.

## Was ein Reviewer in fünf Minuten prüfen kann

1. `npm run build` ohne `.env.local` — läuft es durch, ist die Kapselung der
   Env-Zugriffe in `lib/env.ts` in Ordnung.
2. `db/schema.sql` lesen — steht bei jeder Entscheidung ein Kommentar, warum?
3. `lib/chunk.ts` — bleibt bei einem überlangen Absatz Text übrig oder nicht?
4. `lib/retrieval.ts` — ist die Fusion nachvollziehbar oder eine Blackbox?
5. `git log` — erzählt die Historie den Weg, oder ist es ein Sammel-Commit?
