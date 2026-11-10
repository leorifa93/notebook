import { embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID, openAiApiKey } from "@/lib/env";

/**
 * Embeddings über das Vercel AI SDK.
 *
 * Modell: text-embedding-3-small (1536 Dimensionen, günstig, gut genug für
 * deutsche Sachtexte). Die Dimension steht fest in db/schema.sql als
 * `vector(1536)`; ein Modellwechsel mit anderer Dimension erfordert dort eine
 * Migration, nicht nur eine Env-Änderung.
 */

/** OpenAI erlaubt bis zu 2048 Inputs, wir bleiben konservativ. */
const BATCH_SIZE = 64;

/**
 * Der Provider wird lazy erzeugt: `createOpenAI` wirft, wenn der Key fehlt,
 * und das darf nicht beim Modul-Import während `next build` passieren.
 */
function getProvider() {
  return createOpenAI({ apiKey: openAiApiKey() });
}

/**
 * Erzeugt Embeddings für alle Texte, in Batches.
 *
 * Reihenfolge bleibt garantiert identisch zur Eingabe — darauf verlässt sich
 * der Ingest, wenn er Embedding `i` zu Chunk `i` schreibt.
 */
export async function embedTexts(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const provider = getProvider();
  const model = provider.textEmbeddingModel(EMBEDDING_MODEL_ID);
  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const { embeddings } = await embedMany({
      model,
      values: [...batch],
      maxRetries: 2,
    });

    for (const embedding of embeddings) {
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding hat ${embedding.length} Dimensionen, erwartet ${EMBEDDING_DIMENSIONS}. Passt das Modell zu db/schema.sql?`,
        );
      }
      vectors.push(embedding);
    }
  }

  return vectors;
}

/**
 * Formatiert einen Vektor als pgvector-Literal: `[0.1,0.2,...]`.
 *
 * Wichtig: nicht als Array an `pg` übergeben, sonst landet ein
 * Postgres-Array daraus und der Cast nach `vector` schlägt fehl.
 */
export function toSqlVector(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toFixed(6)).join(",")}]`;
}
