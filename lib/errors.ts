import { APICallError, RetryError } from "ai";

import { ConfigError } from "@/lib/env";

/**
 * Ordnet Fehler von OpenAI, Datenbank und Konfiguration danach, ob ein
 * erneuter Versuch hilft.
 *
 * Live passiert (10.11.2026): Ein falscher Wert in `OPENAI_API_KEY` kam als
 * „Bitte versuche es gleich noch einmal“ beim Nutzer an. Warten hilft bei
 * einem falschen Key, einem fehlenden Key oder leerem Guthaben nie. Nur
 * Netz- und Serverfehler von OpenAI sind vorübergehend.
 *
 * Dasselbe gilt für die Datenbank (F2 aus dem frischen Review): falsches
 * Passwort, fehlendes Schema, falscher Host oder ein SSL-Problem in
 * `DATABASE_URL` — alles am selben Tag live gesehen — kamen als 500 mit
 * „versuche es erneut“ an.
 */

export type UpstreamErrorKind = "config" | "quota" | "transient";

export const CONFIG_ERROR_MESSAGE =
  "Notebook ist gerade nicht vollständig eingerichtet. Ein erneuter Versuch hilft nicht – bitte gib dem Betreiber Bescheid.";

export const QUOTA_ERROR_MESSAGE =
  "Das Kontingent des Demo-Schlüssels ist aufgebraucht. Ein erneuter Versuch hilft nicht.";

/**
 * SQLSTATE-Codes, hinter denen eine falsche Einrichtung steckt:
 * 28P01/28000 Anmeldung (Passwort, Nutzer), 3D000 Datenbank fehlt,
 * 42P01 Tabelle fehlt (db/schema.sql nicht eingespielt), 42883 Operator oder
 * Funktion fehlt und 42704 Typ oder Parameter fehlt (pgvector fehlt oder ist
 * älter als 0.8, siehe `hnsw.iterative_scan` in lib/retrieval.ts).
 */
const DATABASE_CONFIG_CODES = new Set(["28P01", "28000", "3D000", "42P01", "42883", "42704"]);

/**
 * Node-Codes beim Verbindungsaufbau: Host unbekannt, Port verweigert,
 * Zertifikat nicht prüfbar. Bei einem verwalteten Postgres ist das fast
 * immer eine falsche URL oder ein falscher `sslmode`, kein Ausfall.
 * `ETIMEDOUT` und `ECONNRESET` fehlen bewusst: Die kommen auch bei Netzlast.
 */
const CONNECTION_CONFIG_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Fehler ohne aussagekräftigen Code: Supavisor meldet einen falschen Nutzer
 * als `XX000 Tenant or user not found`, `pg` ein SSL-Problem nur als Text.
 */
const CONFIG_MESSAGE_PATTERN =
  /tenant or user not found|self[- ]signed certificate|does not support SSL connections/i;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === "string" ? code : undefined;
}

function isDatabaseConfigError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && (DATABASE_CONFIG_CODES.has(code) || CONNECTION_CONFIG_CODES.has(code))) {
    return true;
  }
  return error instanceof Error && CONFIG_MESSAGE_PATTERN.test(error.message);
}

/** Folgt `cause` und `lastError` (RetryError), höchstens ein paar Ebenen tief. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    chain.push(current);
    current = RetryError.isInstance(current)
      ? current.lastError
      : current instanceof Error
        ? current.cause
        : undefined;
  }
  return chain;
}

export function classifyUpstreamError(error: unknown): UpstreamErrorKind {
  const chain = causeChain(error);
  if (chain.some((link) => link instanceof ConfigError || isDatabaseConfigError(link))) {
    return "config";
  }

  // Nach ausgeschöpften Retries steckt der eigentliche Fehler in `lastError`.
  const cause = RetryError.isInstance(error) ? error.lastError : error;
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
/** Kurzform für die Handler, die nur zwischen 503 und 500 unterscheiden. */
export function isConfigError(error: unknown): boolean {
  return classifyUpstreamError(error) === "config";
}

export function permanentErrorMessage(kind: UpstreamErrorKind): string | null {
  if (kind === "config") return CONFIG_ERROR_MESSAGE;
  if (kind === "quota") return QUOTA_ERROR_MESSAGE;
  return null;
}
