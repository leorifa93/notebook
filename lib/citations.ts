/**
 * Antworttext für die Anzeige zerlegen: Absätze und Belege `[n]`.
 *
 * Reine Funktionen ohne Abhängigkeiten, damit der Chat-Client sie nutzen
 * und Vitest sie ohne DOM prüfen kann. Kein Markdown-Renderer
 * (Entscheidung 5 in docs/schritt-3-plan.md): Belegte Kurzantworten
 * brauchen Absätze, keine Listen oder Fettdruck.
 */

export type AnswerSegment =
  | { type: "text"; text: string }
  /** `index` ist 1-basiert wie `Citation.index`. */
  | { type: "citation"; index: number }
  /**
   * `[n]` ohne passenden Eintrag in der Belegliste. Bleibt als Text sichtbar
   * (mit Warnung), statt still zu verschwinden oder ein toter Button zu
   * werden: Ein erfundener Beleg ist ein Befund, kein Schönheitsfehler.
   */
  | { type: "unknown-citation"; raw: string; index: number };

/**
 * Gleiche Form wie `extractCitationNumbers()` in lib/prompt.ts, damit UI
 * und Eval dieselben Belege sehen. `[1, 2]` oder `[a]` sind kein Beleg
 * und bleiben Text.
 */
const CITATION = /\[(\d+)\]/g;

export function splitCitations(text: string, count: number): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  const pushText = (value: string): void => {
    if (value.length === 0) return;
    const last = segments.at(-1);
    if (last?.type === "text") last.text += value;
    else segments.push({ type: "text", text: value });
  };

  let cursor = 0;
  for (const match of text.matchAll(CITATION)) {
    const start = match.index;
    pushText(text.slice(cursor, start));
    const index = Number(match[1]);
    if (Number.isSafeInteger(index) && index >= 1 && index <= count) {
      segments.push({ type: "citation", index });
    } else {
      segments.push({ type: "unknown-citation", raw: match[0], index });
    }
    cursor = start + match[0].length;
  }
  pushText(text.slice(cursor));
  return segments;
}

/**
 * Absätze an Leerzeilen. Einfache Zeilenumbrüche bleiben im Absatz und
 * werden per `whitespace-pre-line` angezeigt.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}
