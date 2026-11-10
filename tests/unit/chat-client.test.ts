import { Chat } from "@ai-sdk/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { handleChat, type ChatDeps } from "@/app/api/chat/handler";
import { handleIngest } from "@/app/api/ingest/handler";
import { CHAT_MESSAGES, type ChatUIMessage } from "@/lib/chat";
import {
  CLIENT_MESSAGES,
  chatErrorMessage,
  createChatTransport,
  messageCitations,
  messageText,
  prepareChatRequest,
} from "@/lib/chat-client";
import { CONFIG_ERROR_MESSAGE } from "@/lib/errors";
import { ConfigError } from "@/lib/env";
import { REFUSAL_TEXT } from "@/lib/prompt";

import { mockModel, textParts } from "../helpers/chat";
import { stubEmbed } from "../helpers/embeddings";
import { fileFrom, readFixture, uploadRequest } from "../helpers/fixtures";
import { createTestDatabase } from "../helpers/pglite";

/**
 * Chat-Client gegen den echten Handler, ohne Netz und ohne DOM.
 *
 * `Chat` aus @ai-sdk/react ist dieselbe Klasse, die `useChat` intern hält;
 * ihr Transport bekommt statt `fetch` den Handler mit PGlite, Stub-
 * Embeddings und `MockLanguageModelV2`. So ist geprüft, was der Browser
 * schickt und was er aus Stream und Fehlern macht.
 */

const user = (text: string, id = "u1"): ChatUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("prepareChatRequest", () => {
  it("schickt nur die letzte Frage und die Auswahl, nicht den Verlauf", () => {
    const messages: ChatUIMessage[] = [
      user("Erste Frage?", "u1"),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Antwort [1]." }] },
      user("Zweite Frage?", "u2"),
    ];
    const { body } = prepareChatRequest({ messages, body: { documentIds: ["d1", "d2"] } });
    expect(body).toEqual({ question: "Zweite Frage?", documentIds: ["d1", "d2"] });
    expect(Object.keys(body).sort()).toEqual(["documentIds", "question"]);
  });

  it("schickt ohne Auswahl eine leere Liste, damit der Server mit 400 antwortet", () => {
    expect(prepareChatRequest({ messages: [user("Frage?")], body: undefined }).body).toEqual({
      question: "Frage?",
      documentIds: [],
    });
    expect(
      prepareChatRequest({ messages: [user("Frage?")], body: { documentIds: ["d1", 3, null] } })
        .body.documentIds,
    ).toEqual(["d1"]);
  });
});

describe("chatErrorMessage", () => {
  it("liest die Meldung aus unserem JSON-Body", () => {
    expect(chatErrorMessage(new Error(JSON.stringify({ error: "Zu viele Fragen." })))).toBe(
      "Zu viele Fragen.",
    );
  });

  it("zeigt den deutschen errorText aus dem Stream unverändert", () => {
    expect(chatErrorMessage(new Error(CHAT_MESSAGES.timeout))).toBe(CHAT_MESSAGES.timeout);
  });

  it("ersetzt englischen oder technischen Rohtext durch eine deutsche Meldung", () => {
    expect(chatErrorMessage(new TypeError("Failed to fetch"))).toBe(CLIENT_MESSAGES.offline);
    expect(chatErrorMessage(new TypeError("Load failed"))).toBe(CLIENT_MESSAGES.offline);
    expect(chatErrorMessage(new Error("An error occurred."))).toBe(CLIENT_MESSAGES.unknown);
    expect(chatErrorMessage(new Error("<!DOCTYPE html><title>504</title>"))).toBe(
      CLIENT_MESSAGES.unknown,
    );
    expect(chatErrorMessage(new Error("{kaputt"))).toBe(CLIENT_MESSAGES.unknown);
    expect(chatErrorMessage(new Error(JSON.stringify({ message: "x" })))).toBe(
      CLIENT_MESSAGES.unknown,
    );
    expect(chatErrorMessage(new Error(""))).toBe(CLIENT_MESSAGES.unknown);
    expect(chatErrorMessage(undefined)).toBe(CLIENT_MESSAGES.unknown);
  });
});

describe("Chat-Client gegen POST /api/chat", () => {
  let db: PGlite;
  let vertragId: string;
  let lastBody: unknown;

  beforeAll(async () => {
    db = await createTestDatabase();
    const bytes = await readFixture("muster-mietvertrag.pdf");
    const response = await handleIngest(
      uploadRequest(fileFrom(bytes, "muster-mietvertrag.pdf", "application/pdf")),
      { db, embed: stubEmbed },
    );
    vertragId = ((await response.json()) as { id: string }).id;
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    lastBody = undefined;
    await db.exec("DELETE FROM rate_limit_events;");
  });

  function chatWith(overrides: Partial<ChatDeps> = {}): Chat<ChatUIMessage> {
    const model = mockModel();
    const deps: ChatDeps = { db, embed: stubEmbed, model: () => model, ...overrides };
    const transport = createChatTransport(async (input, init) => {
      expect(String(input)).toBe("/api/chat");
      lastBody = JSON.parse(String(init?.body));
      return handleChat(new Request("http://localhost/api/chat", init), deps);
    });
    return new Chat<ChatUIMessage>({ transport });
  }

  async function ask(chat: Chat<ChatUIMessage>, question: string, documentIds: string[]) {
    await chat.sendMessage({ text: question }, { body: { documentIds } });
    return chat.messages.at(-1);
  }

  it("streamt die Antwort mit Belegliste in eine Assistenten-Nachricht", async () => {
    const chat = chatWith();
    const answer = await ask(chat, "Wie hoch ist die Kaution insgesamt?", [vertragId]);

    expect(lastBody).toEqual({ question: "Wie hoch ist die Kaution insgesamt?", documentIds: [vertragId] });
    expect(chat.status).toBe("ready");
    expect(chat.error).toBeUndefined();
    expect(answer?.role).toBe("assistant");
    if (!answer) throw new Error("keine Antwort");
    expect(messageText(answer)).toBe("Die Kaution beträgt 3.450 Euro [1].");
    const citations = messageCitations(answer);
    expect(citations?.length).toBeGreaterThan(0);
    expect(citations?.[0]).toMatchObject({ index: 1, documentId: vertragId, documentTitle: expect.any(String) });
    // Belegliste steht vor dem Text, auch in der fertigen Nachricht.
    expect(answer.parts.findIndex((part) => part.type === "data-citations")).toBeLessThan(
      answer.parts.findIndex((part) => part.type === "text"),
    );
  });

  it("schickt beim zweiten Mal wieder nur die neue Frage und die aktuelle Auswahl", async () => {
    const chat = chatWith();
    await ask(chat, "Wie hoch ist die Kaution insgesamt?", [vertragId]);
    await ask(chat, "Wer ist der Vermieter?", [vertragId]);
    expect(lastBody).toEqual({ question: "Wer ist der Vermieter?", documentIds: [vertragId] });
    expect(chat.messages).toHaveLength(4);
  });

  it("zeigt die Absage mit leerer Belegliste", async () => {
    const answer = await ask(chatWith(), "Quantenchromodynamik Gluonen", [vertragId]);
    if (!answer) throw new Error("keine Antwort");
    expect(messageText(answer)).toBe(REFUSAL_TEXT);
    expect(messageCitations(answer)).toEqual([]);
  });

  it("liest die 400-Meldung ohne Auswahl aus dem JSON-Body", async () => {
    const chat = chatWith();
    await ask(chat, "Frage?", []);
    expect(chat.status).toBe("error");
    expect(chatErrorMessage(chat.error)).toBe(CHAT_MESSAGES.noSources);
  });

  it("zeigt bei fehlender Konfiguration die 503-Meldung ohne Retry-Hinweis", async () => {
    const chat = chatWith({
      embed: async () => {
        throw new ConfigError("OPENAI_API_KEY fehlt");
      },
    });
    await ask(chat, "Wie hoch ist die Kaution insgesamt?", [vertragId]);
    expect(chatErrorMessage(chat.error)).toBe(CONFIG_ERROR_MESSAGE);
  });

  it("behält bei einem Fehler mitten im Stream den Text und zeigt die deutsche Meldung", async () => {
    const parts = textParts("Die Kaution ");
    const broken = [...parts.slice(0, 2), { type: "error" as const, error: new Error("socket hang up") }];
    const model = mockModel(broken);
    const chat = chatWith({ model: () => model });
    const answer = await ask(chat, "Wie hoch ist die Kaution insgesamt?", [vertragId]);

    expect(chat.status).toBe("error");
    expect(chatErrorMessage(chat.error)).toBe(CHAT_MESSAGES.aborted);
    if (!answer) throw new Error("keine Antwort");
    expect(messageText(answer)).toBe("Die Kaution ");
    expect(messageCitations(answer)?.length).toBeGreaterThan(0);
  });
});
