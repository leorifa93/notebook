import { createOpenAI } from "@ai-sdk/openai";
import type { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db";
import { chatModelId, openAiApiKey } from "@/lib/env";

import { handleGetSummary, handlePostSummary, type SummaryDeps } from "./handler";

/**
 * GET  /api/summary → Zusammenfassung zum aktuellen Quellenstand aus dem
 *                     Cache, sonst `{ status: "stale" }`.
 * POST /api/summary → erzeugt sie bei Bedarf (ein Modellaufruf je
 *                     Quellenstand) und cacht sie in `notebook_summaries`.
 *
 * Kein Body: Zusammengefasst wird immer das ganze Notebook, nicht die
 * angehakte Auswahl (Entscheidung 6, sonst sprengte jedes Häkchen den Cache).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function deps(): SummaryDeps {
  return {
    db: getDatabase(),
    model: () => createOpenAI({ apiKey: openAiApiKey() })(chatModelId()),
  };
}

export async function GET(): Promise<NextResponse> {
  return handleGetSummary(deps());
}

export async function POST(request: Request): Promise<NextResponse> {
  return handlePostSummary(request, deps());
}
