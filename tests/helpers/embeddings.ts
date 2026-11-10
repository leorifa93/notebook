import { EMBEDDING_DIMENSIONS } from "@/lib/env";

/**
 * Deterministische Stub-Embeddings statt OpenAI.
 *
 * Wörter werden auf Dimensionen gehasht (Bag of Words) und der Vektor wird
 * normalisiert wie beim echten Modell. Normalisieren ist Pflicht: Fast-Null-
 * Vektoren sind für `<=>` numerisch unbrauchbar (siehe PGlite-Prüfung im
 * Plan von Schritt 2). Gleiche Wörter ergeben ähnliche Vektoren — genug, um
 * die Vektorhälfte der Hybridsuche sinnvoll zu prüfen, ohne Netz und Key.
 */
export function stubEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 2166136261;
    for (const char of word) {
      hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0;
    }
    const index = hash % EMBEDDING_DIMENSIONS;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector);
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

export async function stubEmbed(texts: readonly string[]): Promise<number[][]> {
  return texts.map(stubEmbedding);
}
