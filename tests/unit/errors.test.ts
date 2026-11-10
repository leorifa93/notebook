import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { ConfigError } from "@/lib/env";
import {
  CONFIG_ERROR_MESSAGE,
  QUOTA_ERROR_MESSAGE,
  classifyUpstreamError,
  permanentErrorMessage,
} from "@/lib/errors";

import { dbError } from "../helpers/db-errors";

function apiError(statusCode: number, responseBody = "{}"): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://api.openai.com/v1/embeddings",
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

describe("classifyUpstreamError", () => {
  it("erkennt fehlende Konfiguration", () => {
    expect(classifyUpstreamError(new ConfigError("OPENAI_API_KEY ist nicht gesetzt."))).toBe(
      "config",
    );
  });

  it("wertet einen abgelehnten Key (401/403) als Konfiguration, nicht als vorübergehend", () => {
    expect(classifyUpstreamError(apiError(401))).toBe("config");
    expect(classifyUpstreamError(apiError(403))).toBe("config");
  });

  it("erkennt leeres Guthaben an insufficient_quota", () => {
    const body = JSON.stringify({ error: { code: "insufficient_quota" } });
    expect(classifyUpstreamError(apiError(429, body))).toBe("quota");
  });

  it("hält normales 429, 5xx und unbekannte Fehler für vorübergehend", () => {
    expect(classifyUpstreamError(apiError(429))).toBe("transient");
    expect(classifyUpstreamError(apiError(503))).toBe("transient");
    expect(classifyUpstreamError(new Error("socket hang up"))).toBe("transient");
  });

  it.each([
    ["28P01", 'password authentication failed for user "postgres"'],
    ["28000", "no pg_hba.conf entry for host"],
    ["3D000", 'database "postgres_x" does not exist'],
    ["42P01", 'relation "documents" does not exist'],
    ["42883", "operator does not exist: vector <=> vector"],
    ["42704", 'type "vector" does not exist'],
  ])("wertet den Datenbankcode %s als Konfiguration (F2)", (code, message) => {
    expect(classifyUpstreamError(dbError(message, code))).toBe("config");
  });

  it.each([
    ["ENOTFOUND", "getaddrinfo ENOTFOUND aws-0-eu-west-1.pooler.supabase.co"],
    ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"],
  ])("wertet den Verbindungsfehler %s als Konfiguration (F2)", (code, message) => {
    expect(classifyUpstreamError(dbError(message, code))).toBe("config");
  });

  it("erkennt Konfigurationsfehler ohne Code an der Meldung", () => {
    expect(classifyUpstreamError(dbError("Tenant or user not found", "XX000"))).toBe("config");
    expect(classifyUpstreamError(dbError("The server does not support SSL connections"))).toBe(
      "config",
    );
    expect(classifyUpstreamError(dbError("self-signed certificate in certificate chain"))).toBe(
      "config",
    );
  });

  it("schaut bei verpackten Fehlern auf die Ursache", () => {
    const wrapped = new Error("Abfrage fehlgeschlagen", {
      cause: dbError("password authentication failed", "28P01"),
    });
    expect(classifyUpstreamError(wrapped)).toBe("config");
  });

  it("hält echte Laufzeitfehler der Datenbank weiter für vorübergehend", () => {
    expect(classifyUpstreamError(dbError("Connection terminated unexpectedly"))).toBe("transient");
    expect(classifyUpstreamError(dbError("sorry, too many clients already", "53300"))).toBe(
      "transient",
    );
    expect(classifyUpstreamError(dbError("could not serialize access", "40001"))).toBe(
      "transient",
    );
    expect(classifyUpstreamError(dbError("timeout expired", "ETIMEDOUT"))).toBe("transient");
  });

  it("schaut nach ausgeschöpften Retries auf den letzten Fehler", () => {
    const error = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError(401)],
    });
    expect(classifyUpstreamError(error)).toBe("config");
  });

  it("rät nur bei vorübergehenden Fehlern zum erneuten Versuch", () => {
    expect(permanentErrorMessage("config")).toBe(CONFIG_ERROR_MESSAGE);
    expect(permanentErrorMessage("quota")).toBe(QUOTA_ERROR_MESSAGE);
    expect(permanentErrorMessage("transient")).toBeNull();
    expect(CONFIG_ERROR_MESSAGE).not.toMatch(/gleich noch einmal/);
  });
});
