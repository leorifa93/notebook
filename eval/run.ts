import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

import { handleChat } from "@/app/api/chat/handler";
import { handleIngest } from "@/app/api/ingest/handler";
import { CHAT_TOP_K, MIN_SIMILARITY } from "@/lib/chat";
import { embedTexts } from "@/lib/embeddings";
import { EMBEDDING_MODEL_ID, chatModelId, openAiApiKey } from "@/lib/env";
import type { Citation } from "@/lib/prompt";
import { retrieveAndRerank } from "@/lib/retrieval";

import { readStream, streamedText } from "@/tests/helpers/chat";
import { fileFrom, readFixture, uploadRequest } from "@/tests/helpers/fixtures";
import { createTestDatabase } from "@/tests/helpers/pglite";

import {
  checkThreshold,
  citationsOutOfRange,
  citesExpectedPage,
  expectedPageRank,
  hitsExpectedPage,
  isCleanRefusal,
  isRefusal,
  majority,
  markdownLeftovers,
  matchesExpectation,
  maxCitationsPerStatement,
  median,
  type EvalQuestion,
} from "./metrics";

/**
 * Eval nach docs/eval-plan.md: `npm run eval [-- --runs 3]`.
 *
 * Echte Pipeline, lokale Datenbank: PGlite mit db/schema.sql, die beiden
 * Fixtures aus fixtures/ über den echten Upload-Handler, echte Embeddings
 * und das echte Chatmodell über den echten Chat-Handler. Keine Zeile geht
 * nach Supabase, und kein Nutzerdokument ist im Spiel.
 *
 * Der Key kommt aus .env.local über lib/env.ts und wird nie ausgegeben.
 * Kein CI-Job: Ein Lauf kostet Geld und ist nicht deterministisch.
 */

/** USD je 1 Mio. Tokens, Stand OpenAI-Preisliste November 2026. */
const PRICES = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "text-embedding-3-small": { input: 0.02 },
} as const;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Usage {
  chatInput: number;
  chatOutput: number;
  /** Geschätzt (Zeichen / 4): `embedTexts` gibt die Usage nicht weiter. */
  embeddingTokens: number;
}

interface RunResult {
  answer: string;
  citations: Array<Pick<Citation, "documentTitle" | "page">>;
  /** Absage ohne Modellaufruf (Stufe 1: keine Belege im Stream). */
  stage1: boolean;
  error: string | null;
  refusal: boolean;
  correct: boolean;
  citeOk: boolean | null;
  maxPerStatement: number;
  outOfRange: number[];
  markdown: string[];
}

interface QuestionResult {
  question: EvalQuestion;
  similarity: number;
  recall: boolean | null;
  /** Rang des ersten Chunks der erwarteten Seite, `null` ohne Treffer. */
  rank: number | null;
  retrieved: Array<{ documentTitle: string; page: number | null; similarity: number | null }>;
  runs: RunResult[];
}

function parseRuns(argv: readonly string[]): number {
  const index = argv.indexOf("--runs");
  const value = index >= 0 ? Number(argv[index + 1]) : 3;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("--runs erwartet eine ganze Zahl von 1 bis 5.");
  }
  return value;
}

function usageMiddleware(usage: Usage): LanguageModelMiddleware {
  return {
    middlewareVersion: "v2",
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      const counting = new TransformStream({
        transform(part, controller) {
          if (part.type === "finish") {
            usage.chatInput += part.usage.inputTokens ?? 0;
            usage.chatOutput += part.usage.outputTokens ?? 0;
          }
          controller.enqueue(part);
        },
      });
      return { stream: stream.pipeThrough(counting), ...rest };
    },
  };
}

/** Für ein Modell ohne Eintrag in PRICES (CHAT_MODEL) mit gpt-4o-mini-Preisen geschätzt. */
function cost(usage: Usage, model: string): number {
  const chat = model in PRICES ? PRICES[model as "gpt-4o-mini"] : PRICES["gpt-4o-mini"];
  return (
    (usage.chatInput * chat.input + usage.chatOutput * chat.output) / 1e6 +
    (usage.embeddingTokens * PRICES[EMBEDDING_MODEL_ID].input) / 1e6
  );
}

const mark = (value: boolean | null): string => (value === null ? "–" : value ? "✓" : "✗");
const percent = (part: number, total: number): string =>
  `${part}/${total} (${total === 0 ? 0 : Math.round((part / total) * 100)} %)`;

async function main(): Promise<void> {
  const envFile = `${ROOT}.env.local`;
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  openAiApiKey(); // früh und klar scheitern, ohne den Wert zu zeigen

  const runs = parseRuns(process.argv.slice(2));
  const set = JSON.parse(await readFile(`${ROOT}eval/questions.json`, "utf8")) as {
    documents: string[];
    questions: EvalQuestion[];
  };
  const model = chatModelId();
  const usage: Usage = { chatInput: 0, chatOutput: 0, embeddingTokens: 0 };
  const started = Date.now();

  // Dieselbe Frage wird für Retrieval und Chat eingebettet; einmal reicht.
  const cache = new Map<string, number[]>();
  const embed = async (texts: readonly string[]): Promise<number[][]> => {
    const missing = texts.filter((text) => !cache.has(text));
    if (missing.length > 0) {
      usage.embeddingTokens += Math.ceil(missing.join("").length / 4);
      const vectors = await embedTexts(missing);
      missing.forEach((text, index) => cache.set(text, vectors[index] as number[]));
    }
    return texts.map((text) => cache.get(text) as number[]);
  };

  const db = await createTestDatabase();
  const documentIds: string[] = [];
  for (const name of set.documents) {
    const response = await handleIngest(
      uploadRequest(fileFrom(await readFixture(name), name, "application/pdf")),
      { db, embed },
    );
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`Upload von ${name} fehlgeschlagen: ${response.status} ${await response.text()}`);
    }
    documentIds.push(((await response.json()) as { id: string }).id);
  }

  const chatModel = (): LanguageModel =>
    wrapLanguageModel({
      model: createOpenAI({ apiKey: openAiApiKey() })(model),
      middleware: usageMiddleware(usage),
    });

  const results: QuestionResult[] = [];
  for (const question of set.questions) {
    const chunks = await retrieveAndRerank(question.question, documentIds, { db, embed }, { limit: CHAT_TOP_K });
    const similarity = Math.max(
      0,
      ...chunks.map((chunk) => Math.max(chunk.bestVectorSimilarity ?? 0, chunk.vectorSimilarity ?? 0)),
    );
    const expectsPage = question.document !== undefined && question.pages !== undefined;
    const result: QuestionResult = {
      question,
      similarity,
      recall: expectsPage ? hitsExpectedPage(chunks, question.document as string, question.pages as number[]) : null,
      rank: expectsPage ? expectedPageRank(chunks, question.document as string, question.pages as number[]) : null,
      retrieved: chunks.map((chunk) => ({
        documentTitle: chunk.documentTitle,
        page: chunk.page,
        similarity: chunk.vectorSimilarity,
      })),
      runs: [],
    };

    for (let run = 0; run < runs; run += 1) {
      // Lokale Datenbank: Das Rate-Limit soll das Eval nicht bremsen.
      await db.exec("DELETE FROM rate_limit_events;");
      const response = await handleChat(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: question.question, documentIds }),
        }),
        { db, embed, model: chatModel },
      );
      const parts = response.ok ? await readStream(response) : [];
      const citations = (parts.find((part) => part.type === "data-citations")?.data ?? []) as Citation[];
      const answer = streamedText(parts);
      const errorPart = parts.find((part) => part.type === "error");
      const refusal = isRefusal(answer);
      const shouldAnswer = question.group === "answer" || question.group === "injection";
      result.runs.push({
        answer,
        citations: citations.map(({ documentTitle, page }) => ({ documentTitle, page })),
        stage1: refusal && citations.length === 0,
        error: response.ok ? (errorPart ? String(errorPart.errorText) : null) : `${response.status} ${await response.text()}`,
        refusal,
        correct: shouldAnswer ? !refusal && matchesExpectation(answer, question) : isCleanRefusal(answer, question),
        citeOk: expectsPage
          ? citesExpectedPage(answer, citations, question.document as string, question.pages as number[])
          : null,
        maxPerStatement: maxCitationsPerStatement(answer),
        outOfRange: citationsOutOfRange(answer, citations.length),
        markdown: markdownLeftovers(answer),
      });
    }
    results.push(result);
    process.stdout.write(`${question.id} `);
  }
  process.stdout.write("\n\n");
  await db.close();

  report(results, { runs, model, usage, seconds: (Date.now() - started) / 1000 });
  await mkdir(`${ROOT}eval/results`, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `${ROOT}eval/results/lauf-${stamp}.json`;
  await writeFile(
    file,
    `${JSON.stringify({ date: new Date().toISOString(), model, runs, minSimilarity: MIN_SIMILARITY, usage, costUsd: cost(usage, model), results }, null, 2)}\n`,
  );
  console.info(`Rohdaten: ${file.slice(ROOT.length)}`);
}

function report(
  results: readonly QuestionResult[],
  meta: { runs: number; model: string; usage: Usage; seconds: number },
): void {
  const lines = [
    "| Frage | Gruppe | Ähnlichkeit | Recall@5 | Rang | Antwort ok | Zitat ok | max. Belege/Aussage | Stufe-1-Absage |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const { runs } = result;
    const citeOk = result.question.pages ? majority(runs.map((run) => run.citeOk === true)) : null;
    lines.push(
      [
        result.question.id,
        result.question.group,
        result.similarity.toFixed(3),
        mark(result.recall),
        result.rank === null ? "–" : String(result.rank),
        `${mark(majority(runs.map((run) => run.correct)))} (${runs.filter((run) => run.correct).length}/${runs.length})`,
        mark(citeOk),
        String(Math.max(...runs.map((run) => run.maxPerStatement))),
        `${runs.filter((run) => run.stage1).length}/${runs.length}`,
      ].join(" | ").replace(/^/, "| ").concat(" |"),
    );
  }

  const answerable = results.filter((result) => result.question.pages !== undefined);
  const mustRefuse = results.filter((result) => result.question.group === "refuse" || result.question.group === "offtopic");
  const mustAnswer = results.filter((result) => result.question.group === "answer" || result.question.group === "injection");
  const perRun = (pick: (run: RunResult) => boolean, of: readonly QuestionResult[]): number =>
    median(Array.from({ length: meta.runs }, (_, index) => of.filter((result) => pick(result.runs[index] as RunResult)).length));
  const allRuns = results.flatMap((result) => result.runs);

  const threshold = checkThreshold(
    MIN_SIMILARITY,
    results.map((result) => ({ group: result.question.group, similarity: result.similarity })),
  );

  lines.push(
    "",
    `Recall@5:                    ${percent(answerable.filter((result) => result.recall).length, answerable.length)}`,
    `Treffer auf Rang 1:          ${percent(answerable.filter((result) => result.rank === 1).length, answerable.length)}`,
    `Antwort korrekt (Median):    ${percent(perRun((run) => run.correct, mustAnswer), mustAnswer.length)}`,
    `Zitat-Präzision (Median):    ${percent(perRun((run) => run.citeOk === true, answerable), answerable.length)}`,
    `Absage korrekt (Median):     ${percent(perRun((run) => run.correct, mustRefuse), mustRefuse.length)}`,
    `Falsche Absage (Median):     ${percent(perRun((run) => run.refusal, mustAnswer), mustAnswer.length)}`,
    `Aussagen mit > 2 Belegen:    ${allRuns.filter((run) => run.maxPerStatement > 2).length} von ${allRuns.length} Antworten`,
    `[n] außerhalb der Liste:     ${allRuns.filter((run) => run.outOfRange.length > 0).length} von ${allRuns.length} Antworten`,
    `Markdown-Reste:              ${allRuns.filter((run) => run.markdown.length > 0).length} von ${allRuns.length} Antworten`,
    `Fehler im Stream:            ${allRuns.filter((run) => run.error !== null).length}`,
    "",
    `Schwelle MIN_SIMILARITY = ${MIN_SIMILARITY}: kleinste Ähnlichkeit beantwortbar ${threshold.minAnswerable.toFixed(3)}, ` +
      `größte Off-Topic ${threshold.maxOfftopic.toFixed(3)}, größte D-Frage ${threshold.maxMissing.toFixed(3)}, ` +
      `trennt Off-Topic: ${threshold.separatesOfftopic ? "ja" : "nein"}` +
      (threshold.gapMidpoint === null ? "" : `, Mitte der Lücke ${threshold.gapMidpoint.toFixed(3)}`),
    "",
    `Modell ${meta.model}, ${meta.runs} Läufe, ${meta.seconds.toFixed(0)} s, Tokens Chat ${meta.usage.chatInput} ein / ${meta.usage.chatOutput} aus, ` +
      `Embeddings ~${meta.usage.embeddingTokens}, Kosten ~${cost(meta.usage, meta.model).toFixed(4)} USD`,
  );
  console.info(lines.join("\n"));
}

main().catch((error: unknown) => {
  console.error("[eval] abgebrochen", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
