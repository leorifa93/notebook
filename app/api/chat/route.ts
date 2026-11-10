import { NextResponse } from "next/server";

/**
 * POST /api/chat
 *
 * Nimmt eine Frage entgegen und streamt eine belegte Antwort.
 *
 * Schritt 1: nur Validierung. Die eigentliche Kette ist vorbereitet:
 *
 *   1. Body lesen        → { question, documentIds? }
 *   2. Suchen            → retrieve()       (lib/retrieval.ts)
 *   3. Prompt bauen      → buildUserPrompt(), SYSTEM_PROMPT (lib/prompt.ts)
 *   4. Streamen          → streamText() + toUIMessageStreamResponse() aus "ai"
 *
 * Warum Streaming überhaupt: Die erste Antwortzeile ist nach ~500 ms da statt
 * nach 8 Sekunden. Bei einer Live-Demo ist das der Unterschied zwischen
 * "läuft" und "hängt". Zusätzlich schicken wir die Belegliste vor dem
 * Textstream, damit die Quellenkarten schon stehen, während die Antwort
 * noch tippt.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

interface ChatRequestBody {
  question?: unknown;
  documentIds?: unknown;
}

export async function POST(request: Request): Promise<NextResponse | Response> {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Body ist kein gültiges JSON." },
      { status: 400 },
    );
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";

  if (question.length === 0) {
    return NextResponse.json(
      { error: "Feld 'question' fehlt oder ist leer." },
      { status: 400 },
    );
  }

  if (question.length > 2000) {
    return NextResponse.json(
      { error: "Die Frage ist zu lang (maximal 2000 Zeichen)." },
      { status: 400 },
    );
  }

  const documentIds = Array.isArray(body.documentIds)
    ? body.documentIds.filter((id): id is string => typeof id === "string")
    : undefined;

  // TODO(Schritt 3):
  //   const chunks = await retrieveAndRerank(question, { documentIds });
  //   const result = streamText({
  //     model: createOpenAI({ apiKey: openAiApiKey() })(chatModelId()),
  //     system: SYSTEM_PROMPT,
  //     prompt: buildUserPrompt(question, chunks),
  //     temperature: 0.1,
  //   });
  //   return result.toUIMessageStreamResponse({
  //     messageMetadata: () => ({ citations: buildCitations(chunks) }),
  //   });
  //
  // `temperature: 0.1` ist Absicht: bei einer belegpflichtigen Antwort gibt es
  // keinen Grund für Kreativität, nur für Formulierung.
  return NextResponse.json(
    {
      error: "Chat ist noch nicht implementiert (Schritt 1: Gerüst).",
      hint: "retrieve() in lib/retrieval.ts und buildUserPrompt() in lib/prompt.ts sind vorbereitet.",
      received: { question, documentIds: documentIds ?? null },
    },
    { status: 501 },
  );
}
