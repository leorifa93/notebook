import { APICallError, RetryError } from "ai";

import { ConfigError } from "@/lib/env";

/**
 * Ordnet Fehler von OpenAI und Konfiguration danach, ob ein erneuter Versuch
 * hilft.
 *
 * Live passiert (10.11.2026): Ein falscher Wert in `OPENAI_API_KEY` kam als
 * „Bitte versuche es gleich noch einmal“ beim Nutzer an. Warten hilft bei
 * einem falschen Key, einem fehlenden Key oder leerem Guthaben nie. Nur
 * Netz- und Serverfehler von OpenAI sind vorübergehend.
 */

export type UpstreamErrorKind = "config" | "quota" | "transient";

export const CONFIG_ERROR_MESSAGE =
  "Notebook ist gerade nicht vollständig eingerichtet. Ein erneuter Versuch hilft nicht – bitte gib dem Betreiber Bescheid.";

export const QUOTA_ERROR_MESSAGE =
  "Das Kontingent des Demo-Schlüssels ist aufgebraucht. Ein erneuter Versuch hilft nicht.";

export function classifyUpstreamError(error: unknown): UpstreamErrorKind {
  // Nach ausgeschöpften Retries steckt der eigentliche Fehler in `lastError`.
  const cause = RetryError.isInstance(error) ? error.lastError : error;

  if (cause instanceof ConfigError) return "config";
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    if (status === 401 || status === 403) return "config";
    if (status === 429 && (cause.responseBody ?? "").includes("insufficient_quota")) {
      return "quota";
    }
  }
  return "transient";
}

/** Fehler aus einem Aufruf bei OpenAI (direkt oder nach Retries). */
export function isUpstreamApiError(error: unknown): boolean {
  return APICallError.isInstance(error) || RetryError.isInstance(error);
}

/** Meldung für die Fälle, in denen Warten nicht hilft; sonst `null`. */
export function permanentErrorMessage(kind: UpstreamErrorKind): string | null {
  if (kind === "config") return CONFIG_ERROR_MESSAGE;
  if (kind === "quota") return QUOTA_ERROR_MESSAGE;
  return null;
}
