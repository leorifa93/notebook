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

/**
 * Unsichtbare Zeichen, die mitten in einem Wort stehen können: weiches
 * Trennzeichen, Nullbreiten-Leerzeichen, Wortverbinder und ein BOM, das nicht
 * am Dateianfang steht. Im Bild fehlen sie, für `to_tsvector` teilen oder
 * verfälschen sie das Wort: „Lebens\u200Blauf“ findet „Lebenslauf“ nie.
 * Nullbreiten-(Nicht-)Verbinder (U+200C/U+200D) bleiben, sie bauen Emoji und
 * manche Schriften zusammen.
 */
const INVISIBLE_IN_WORD = /\u00AD\n?|[\u200B\u2060\uFEFF]/g;

/** Ein einzelnes Surrogat ohne Partner; `u`-Modus, sonst träfe es auch Paare. */
const LONE_SURROGATE = /\p{Cs}/gu;

/**
 * Bereinigt Text, der in Index, Suche oder Prompt geht: Dokumentinhalt,
 * Titel und Frage.
 *
 * Neben den Steuerzeichen aus `stripControlChars` fallen unsichtbare Zeichen
 * und einzelne Surrogate weg (die JSON zum Modell nur als `\ud800` tragen
 * kann). Danach NFC: Dateien vom Mac und manche PDFs liefern „ö“ als „o“ plus
 * Trema; `to_tsvector('german')` macht daraus einen anderen Wortstamm als aus
 * der getippten Frage, die Volltextsuche fände nichts.
 *
 * Bewusst nicht NFKC: Das machte aus „m²“ ein „m2“ und änderte so den Text,
 * der als Beleg zitiert wird.
 */
export function cleanText(raw: string): string {
  return stripControlChars(raw)
    .replace(INVISIBLE_IN_WORD, "")
    .replace(LONE_SURROGATE, "")
    .normalize("NFC");
}
