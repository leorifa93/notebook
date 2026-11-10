import { describe, expect, it } from "vitest";
import { POST as chatPost } from "@/app/api/chat/route";
import { POST as ingestPost } from "@/app/api/ingest/route";

/**
 * Diese Tests prüfen die Verträge der Routen, nicht die Fachlogik: Eingaben
 * werden validiert, bevor irgendetwas Teures passiert. In Schritt 1 antworten
 * die Handler mit 501 — genau das wird hier festgehalten, damit Schritt 2
 * diesen Test bewusst umschreiben muss, statt still etwas anderes zu tun.
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

  it("akzeptiert eine gültige Frage und meldet in Schritt 1 ehrlich 501", async () => {
    const response = await chatPost(
      jsonRequest("http://localhost/api/chat", { question: "Wie hoch ist die Kaution?" }),
    );
    expect(response.status).toBe(501);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("noch nicht implementiert");
  });

  it("filtert ungültige documentIds, statt die Anfrage abzulehnen", async () => {
    const response = await chatPost(
      jsonRequest("http://localhost/api/chat", {
        question: "Frage",
        documentIds: ["a", 42, null, "b"],
      }),
    );
    const payload = (await response.json()) as {
      received?: { documentIds?: string[] | null };
    };
    expect(payload.received?.documentIds).toEqual(["a", "b"]);
  });
});

describe("POST /api/ingest", () => {
  it("weist eine Anfrage ohne Datei mit 400 ab", async () => {
    const response = await ingestPost(
      new Request("http://localhost/api/ingest", { method: "POST" }),
    );
    expect(response.status).toBe(400);
  });

  it("weist eine Datei mit PDF-Endung, aber ohne lesbares PDF mit 400 ab", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([37, 80, 68, 70])], "test.pdf", {
        type: "application/pdf",
      }),
    );
    const response = await ingestPost(
      new Request("http://localhost/api/ingest", { method: "POST", body: form }),
    );
    expect(response.status).toBe(400);
  });
});
