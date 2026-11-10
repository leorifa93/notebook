/**
 * Upload-Grenzen, geteilt von Server (Validierung) und Client (Vorabprüfung).
 *
 * 4 MB, weil Vercel Serverless den Request-Body bei etwa 4,5 MB abschneidet.
 * Größere Dateien kämen auf dem Live-Deployment als stiller 413 der
 * Plattform an, ohne unsere deutsche Fehlermeldung. Deshalb prüft der Client
 * dieselbe Grenze vor dem Senden.
 *
 * 40 Seiten halten den Ingest unter `maxDuration = 60` und im Budget des
 * Demo-Keys.
 *
 * Diese Datei enthält nur Konstanten und darf in Client-Komponenten landen.
 */

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PDF_PAGES = 40;

/**
 * Obergrenze für Abschnitte pro Quelle, für alle Typen. Das Seitenlimit greift
 * nur bei PDFs; eine 4-MB-Textdatei ergäbe sonst rund 3.000 Chunks und
 * 47 Embedding-Batches nacheinander, weit über `maxDuration`. 200 lässt einem
 * dichten 40-Seiten-PDF (ein bis drei Chunks pro Seite) reichlich Luft.
 */
export const MAX_CHUNKS_PER_SOURCE = 200;

/** Für `<input type="file" accept>`; die eigentliche Prüfung macht der Server. */
export const ACCEPTED_FILE_TYPES =
  ".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain";

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
}
