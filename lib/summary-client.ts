import { SUMMARY_MESSAGES, type SummaryResponse, type SummaryView } from "@/lib/summary";

/**
 * Zusammenfassung im Browser: erst GET (Cache), bei `stale` einmal POST.
 * Ohne React, damit die Tests den Ablauf gegen die echten Handler prüfen
 * können (tests/unit/summary-client.test.ts).
 */

export type OverviewState =
  | { status: "loading"; phase: "checking" | "generating" }
  | { status: "empty" }
  | { status: "ready"; summary: SummaryView }
  | { status: "unavailable" }
  /** `retryable: false` bei 503 (Einrichtung, Guthaben) und 429: Gleich nochmal hilft nicht. */
  | { status: "error"; message: string; retryable: boolean };

export const OVERVIEW_MESSAGES = {
  offline: "Die Zusammenfassung konnte nicht geladen werden. Besteht eine Verbindung?",
  unknown: SUMMARY_MESSAGES.failed,
} as const;

function isSummaryResponse(value: unknown): value is SummaryResponse {
  if (typeof value !== "object" || value === null) return false;
  const { status } = value as { status?: unknown };
  return status === "empty" || status === "stale" || status === "ready" || status === "unavailable";
}

/** Fehlermeldung des Servers (`{ error }`), sonst eine eigene. */
async function errorState(response: Response): Promise<OverviewState> {
  const retryable = response.status !== 503 && response.status !== 429;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) {
      return { status: "error", message: body.error, retryable };
    }
  } catch {
    // Kein JSON (etwa eine HTML-Seite der Plattform): Meldung unten.
  }
  return { status: "error", message: OVERVIEW_MESSAGES.unknown, retryable };
}

const UNKNOWN: OverviewState = { status: "error", message: OVERVIEW_MESSAGES.unknown, retryable: true };

function toState(body: SummaryResponse): OverviewState {
  if (body.status === "ready") return { status: "ready", summary: body.summary };
  if (body.status === "empty") return { status: "empty" };
  return { status: "unavailable" };
}

/**
 * Lädt die Zusammenfassung und meldet Zwischenstände über `onProgress`.
 * Erzeugt wird höchstens einmal pro Aufruf; ein Abbruch über `signal`
 * (Quellen haben sich geändert) wirft `AbortError` an den Aufrufer.
 */
export async function loadOverview(
  fetch: typeof globalThis.fetch,
  options: { signal?: AbortSignal; onProgress?: (state: OverviewState) => void } = {},
): Promise<OverviewState> {
  const { signal, onProgress } = options;
  try {
    const cached = await fetch("/api/summary", { cache: "no-store", signal });
    if (!cached.ok) return errorState(cached);
    const body: unknown = await cached.json();
    if (!isSummaryResponse(body)) return UNKNOWN;
    if (body.status !== "stale") return toState(body);

    onProgress?.({ status: "loading", phase: "generating" });
    const generated = await fetch("/api/summary", { method: "POST", signal });
    if (!generated.ok) return errorState(generated);
    const result: unknown = await generated.json();
    if (!isSummaryResponse(result) || result.status === "stale") return UNKNOWN;
    return toState(result);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "error", message: OVERVIEW_MESSAGES.offline, retryable: true };
  }
}
