/**
 * Textbereinigung ohne Abhängigkeiten.
 *
 * Eigene Datei, weil der Chat nur diese Regex braucht: Aus lib/pdf.ts
 * importiert, zog sie `unpdf` samt pdf.js in das Bundle der Chat-Route und
 * verlängerte deren Kaltstart (F4 aus dem frischen Review von Schritt 3).
 */

/**
 * Entfernt Steuerzeichen, die Postgres in `text` nicht speichern kann.
 *
 * Manche PDFs (etwa aus Word mit eingebetteten Schriften) liefern über pdf.js
 * NUL-Bytes (U+0000) im Text. Postgres lehnt die mit
 * `invalid byte sequence for encoding "UTF8": 0x00` ab und der ganze Ingest
 * scheitert. Zeilenumbruch und Tab bleiben erhalten, alle anderen C0-Zeichen
 * und DEL fliegen raus; sie tragen für Suche und Embedding keine Bedeutung.
 */
export function stripControlChars(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
