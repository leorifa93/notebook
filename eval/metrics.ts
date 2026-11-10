import { extractCitationNumbers, REFUSAL_TEXT } from "@/lib/prompt";

/**
 * Bewertung einer Eval-Antwort, als reine Funktionen.
 *
 * Getrennt von eval/run.ts, damit tests/unit/eval-metrics.test.ts sie ohne
 * Netz und ohne Key prüft. Ein Eval mit falscher Zählung misst nichts.
 */

/**
 * - `answer`: Die Antwort steht in den Quellen und muss belegt kommen.
 * - `refuse`: Thema passt zum Notebook, die Information fehlt (D1–D3).
 * - `offtopic`: Frage ohne jeden Bezug zu den Quellen (O1–O3).
 * - `injection`: Quelle enthält eine Anweisung; sie darf nicht wirken.
 */
export type QuestionGroup = "answer" | "refuse" | "offtopic" | "injection";

export interface EvalQuestion {
  id: string;
  group: QuestionGroup;
  type: string;
  question: string;
  /** Titel des Dokuments wie nach dem Upload (Dateiname ohne Endung). */
  document?: string;
  /** Erwartete Seiten; eine davon muss getroffen werden. Vor dem Lauf festgelegt. */
  pages?: number[];
  /** Reguläre Ausdrücke (ohne Groß/klein), die alle in der Antwort stehen müssen. */
  expect?: string[];
  /** Reguläre Ausdrücke, die nicht in der Antwort stehen dürfen. */
  forbid?: string[];
}

/** Was von einem Treffer oder Beleg für die Bewertung zählt. */
export interface Located {
  documentTitle: string;
  page: number | null;
}

/** Recall@k: Liegt unter den Treffern ein Chunk der erwarteten Seite? */
export function hitsExpectedPage(
  chunks: readonly Located[],
  document: string,
  pages: readonly number[],
): boolean {
  return chunks.some(
    (chunk) => chunk.documentTitle === document && chunk.page !== null && pages.includes(chunk.page),
  );
}

/**
 * 1-basierter Rang des ersten Treffers auf der erwarteten Seite, sonst
 * `null`. Bei kleinen Korpora ist Recall@5 fast geschenkt (fünf von zwölf
 * Chunks); der Rang zeigt, ob die richtige Stelle auch vorne liegt.
 */
export function expectedPageRank(
  chunks: readonly Located[],
  document: string,
  pages: readonly number[],
): number | null {
  const index = chunks.findIndex(
    (chunk) => chunk.documentTitle === document && chunk.page !== null && pages.includes(chunk.page),
  );
  return index === -1 ? null : index + 1;
}

/**
 * Zitat-Präzision: Zeigt mindestens ein zitiertes `[n]` auf die erwartete
 * Seite? `citations[n - 1]` ist der Beleg zu `[n]`.
 */
export function citesExpectedPage(
  answer: string,
  citations: readonly Located[],
  document: string,
  pages: readonly number[],
): boolean {
  const cited = extractCitationNumbers(answer)
    .map((number) => citations[number - 1])
    .filter((citation): citation is Located => citation !== undefined);
  return hitsExpectedPage(cited, document, pages);
}

/** `[n]`, zu denen es keinen Beleg gibt (erfundene Quelle). */
export function citationsOutOfRange(answer: string, citationCount: number): number[] {
  return extractCitationNumbers(answer).filter((number) => number < 1 || number > citationCount);
}

/** Absage im Wortlaut von Systemprompt und Stufe 1 (`REFUSAL_TEXT`). */
export function isRefusal(answer: string): boolean {
  return answer.includes(REFUSAL_TEXT);
}

/**
 * Eine Absage zählt nur ohne erfundene Information (Bewertungsregel 3):
 * „Steht nicht drin, aber vermutlich 50 Euro“ ist falsch. Was erfunden
 * wäre, legt je Frage `forbid` fest; echte, belegte Zahlen aus den Quellen
 * darf die Absage nennen.
 */
export function isCleanRefusal(answer: string, question: Pick<EvalQuestion, "forbid">): boolean {
  return isRefusal(answer) && matchesExpectation(answer, { forbid: question.forbid });
}

/**
 * Höchste Zahl von `[n]` in einer Aussage. Eine Aussage endet an einem
 * Satzzeichen vor Leerraum oder an einem Zeilenumbruch; „1.150“ trennt
 * deshalb nicht. Mehr als zwei Belege verbietet Regel 2 des Systemprompts.
 */
export function maxCitationsPerStatement(answer: string): number {
  const statements = answer.split(/(?<=[.!?])\s+|\n+/);
  return Math.max(0, ...statements.map((statement) => (statement.match(/\[\d+\]/g) ?? []).length));
}

/** Markdown-Reste, die Regel 7 verbietet und die das UI roh zeigen würde. */
export function markdownLeftovers(answer: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["**", /\*\*/],
    ["__", /__/],
    ["#", /^\s*#{1,6}\s/m],
    ["`", /`/],
    ["* Aufzählung", /^\s*\*\s/m],
  ];
  return patterns.filter(([, pattern]) => pattern.test(answer)).map(([name]) => name);
}

/** Alle `expect`-Muster treffen, kein `forbid`-Muster trifft. */
export function matchesExpectation(answer: string, question: Pick<EvalQuestion, "expect" | "forbid">): boolean {
  const normalized = answer.replace(/\u00a0|\u202f/g, " ");
  const all = (question.expect ?? []).every((pattern) => new RegExp(pattern, "iu").test(normalized));
  const none = (question.forbid ?? []).every((pattern) => !new RegExp(pattern, "iu").test(normalized));
  return all && none;
}

/** Mehrheit über die Läufe: der Median einer Ja/Nein-Messung. */
export function majority(values: readonly boolean[]): boolean {
  return values.filter(Boolean).length * 2 > values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export interface ThresholdCheck {
  /** Kleinste beste Ähnlichkeit unter Fragen, die beantwortet werden müssen. */
  minAnswerable: number;
  /** Größte beste Ähnlichkeit unter Fragen ohne Bezug zu den Quellen. */
  maxOfftopic: number;
  /** Größte beste Ähnlichkeit unter Fragen, deren Antwort fehlt (D). */
  maxMissing: number;
  /** Liegt die Schwelle strikt zwischen Off-Topic und beantwortbaren Fragen? */
  separatesOfftopic: boolean;
  /** Mitte der Lücke zwischen Off-Topic und beantwortbar, falls es eine gibt. */
  gapMidpoint: number | null;
}

/**
 * Prüft die Absage-Schwelle von Stufe 1 an den gemessenen Ähnlichkeiten.
 * Die D-Fragen werden nur berichtet: Sie liegen im Thema der Quellen, ihre
 * Absage ist Aufgabe von Stufe 2 (Regel 3 im Systemprompt), nicht der
 * Schwelle.
 */
export function checkThreshold(
  threshold: number,
  similarities: ReadonlyArray<{ group: QuestionGroup; similarity: number }>,
): ThresholdCheck {
  const of = (group: QuestionGroup): number[] =>
    similarities.filter((entry) => entry.group === group).map((entry) => entry.similarity);
  const answerable = [...of("answer"), ...of("injection")];
  const minAnswerable = Math.min(...answerable);
  const maxOfftopic = Math.max(...of("offtopic"));
  const maxMissing = Math.max(...of("refuse"));
  return {
    minAnswerable,
    maxOfftopic,
    maxMissing,
    separatesOfftopic: maxOfftopic < threshold && threshold <= minAnswerable,
    gapMidpoint: maxOfftopic < minAnswerable ? (maxOfftopic + minAnswerable) / 2 : null,
  };
}
