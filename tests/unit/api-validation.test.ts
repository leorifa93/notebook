import { describe, expect, it } from "vitest";
import { POST as chatPost } from "@/app/api/chat/route";
import { POST as ingestPost } from "@/app/api/ingest/route";

/**
 * Diese Tests prüfen die Verträge der Routen, nicht die Fachlogik: Eingaben
 * werden validiert, bevor irgendetwas Teures passiert — ohne Datenbank und
 * ohne Key. Den Chat-Pfad mit Datenbank und Modell prüft
 * tests/unit/chat.test.ts; die 501-Erwartung aus Schritt 1 ist dort
 * bewusst ersetzt. Der Ingest-501-Test aus Schritt 1 ist in
 * Schritt 2 durch tests/unit/ingest.test.ts ersetzt (echte Pipeline gegen
 * PGlite); hier bleibt nur die Prüfung, die keine Datenbank braucht.
 */

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat", () => {
  it("weist kaputtes JSON mit 400 ab", async () => {
    const response = await chatPost(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: "{ kein json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("weist eine leere Frage mit 400 ab", async () => {
    const response = await chatPost(jsonRequest("http://localhost/api/chat", { question: "  " }));
    expect(response.status).toBe(400);
  });

  it("weist eine zu lange Frage mit 400 ab", async () => {
    const response = await chatPost(
      jsonRequest("http://localhost/api/chat", { question: "x".repeat(2001) }),
    );
    expect(response.status).toBe(400);
  });

  it("lehnt eine fehlende oder leere Quellenauswahl mit 400 ab, statt alles zu durchsuchen", async () => {
    for (const body of [{ question: "Frage" }, { question: "Frage", documentIds: [] }]) {
      const response = await chatPost(jsonRequest("http://localhost/api/chat", body));
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error?: string };
      expect(payload.error).toContain("mindestens eine Quelle");
    }
  });

  it("lehnt ungültige documentIds mit 400 ab statt mit 500 aus der Datenbank", async () => {
    const response = await chatPost(
      jsonRequest("http://localhost/api/chat", {
        question: "Frage",
        documentIds: ["a", 42, null, "b"],
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("ungültige ID");
  });
});

describe("POST /api/ingest", () => {
  it("weist eine Anfrage ohne Datei mit 400 ab", async () => {
    const response = await ingestPost(
      new Request("http://localhost/api/ingest", { method: "POST" }),
    );
    expect(response.status).toBe(400);
  });
});
