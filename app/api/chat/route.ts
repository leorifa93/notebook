import { createOpenAI } from "@ai-sdk/openai";

import { getDatabase } from "@/lib/db";
import { embedTexts } from "@/lib/embeddings";
import { chatModelId, openAiApiKey } from "@/lib/env";

import { handleChat } from "./handler";

/**
 * POST /api/chat
 *
 * Body `{ question, documentIds }`: eine Frage zu den angehakten Quellen,
 * bewusst ohne Verlauf (Entscheidung 3 in docs/schritt-3-plan.md). Antwort
 * ist ein UI-Message-Stream des AI SDK: zuerst die Belegliste als
 * `data-citations`, dann der Text mit `[n]`.
 *
 * Warum Streaming: Die erste Zeile steht nach ~500 ms statt nach
 * 8 Sekunden. In einer Live-Demo ist das der Unterschied zwischen „läuft“
 * und „hängt“.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleChat(request, {
    db: getDatabase(),
    embed: embedTexts,
    model: () => createOpenAI({ apiKey: openAiApiKey() })(chatModelId()),
  });
}
