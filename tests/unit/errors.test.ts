import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { ConfigError } from "@/lib/env";
import {
  CONFIG_ERROR_MESSAGE,
  QUOTA_ERROR_MESSAGE,
  classifyUpstreamError,
  permanentErrorMessage,
} from "@/lib/errors";

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
