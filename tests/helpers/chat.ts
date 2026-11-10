import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";

/**
 * Hilfen für Chat-Tests: ein Mock-Modell, das einen festen Text streamt,
 * und ein Parser für den SSE-Body des UI-Message-Streams.
 */

type StreamPart =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "error"; error: unknown }
  | {
      type: "finish";
      finishReason: "stop";
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };

export function textParts(...deltas: string[]): StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  ];
}

export function mockModel(parts: StreamPart[] = textParts("Die Kaution beträgt ", "3.450 Euro [1].")) {
  return new MockLanguageModelV2({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: parts }) }),
  });
}

/** Modell, das nach dem ersten Wort hängt, bis das Signal abbricht. */
export function hangingModel() {
  return new MockLanguageModelV2({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Die " });
          abortSignal?.addEventListener("abort", () => {
            controller.error(abortSignal.reason);
          });
        },
      }),
    }),
  });
}

export interface StreamChunk {
  type: string;
  [key: string]: unknown;
}

/** Liest alle `data:`-Zeilen eines SSE-Bodys als JSON. */
export async function readStream(response: Response): Promise<StreamChunk[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as StreamChunk);
}

export function streamedText(chunks: readonly StreamChunk[]): string {
  return chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => String(chunk.delta))
    .join("");
}
