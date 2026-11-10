import { DefaultChatTransport } from "ai";

import type { ChatRequest, ChatUIMessage } from "@/lib/chat";
import type { Citation } from "@/lib/prompt";

/**
 * Chat im Browser: was an POST /api/chat geht und wie Antworten und Fehler
 * gelesen werden. Ohne React, damit die Tests Transport und Server-Handler
 * ohne DOM zusammenstecken können (tests/unit/chat-client.test.ts).
 */

export const CLIENT_MESSAGES = {
  offline: "Notebook ist gerade nicht erreichbar. Besteht eine Verbindung?",
  unknown: "Die Antwort konnte nicht geladen werden. Bitte stelle die Frage erneut.",
} as const;

interface PrepareInput {
  messages: readonly ChatUIMessage[];
  body: Record<string, unknown> | undefined;
}

/** Text einer Nachricht, ohne Data-Parts. */
export function messageText(message: ChatUIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** Belegliste einer Antwort; `null`, solange `data-citations` noch fehlt. */
export function messageCitations(message: ChatUIMessage): Citation[] | null {
  for (const part of message.parts) {
    if (part.type === "data-citations") return part.data;
  }
  return null;
}

/**
 * Body für POST /api/chat. `useChat` würde sonst den ganzen Verlauf
 * schicken; der Server erwartet aber genau eine Frage (Entscheidung 3 in
 * docs/schritt-3-plan.md). Die Auswahl kommt pro Frage über
 * `sendMessage(…, { body: { documentIds } })`, nicht über eine Closure:
 * Der Transport lebt so lange wie der Chat, die Häkchen ändern sich.
 */
export function prepareChatRequest({ messages, body }: PrepareInput): { body: ChatRequest } {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const rawIds = body?.documentIds;
  const documentIds = Array.isArray(rawIds)
    ? rawIds.filter((id): id is string => typeof id === "string")
    : [];
  return {
    body: { question: lastUser ? messageText(lastUser) : "", documentIds },
  };
}

export function createChatTransport(fetch?: typeof globalThis.fetch): DefaultChatTransport<ChatUIMessage> {
  return new DefaultChatTransport<ChatUIMessage>({
    api: "/api/chat",
    fetch,
    prepareSendMessagesRequest: ({ messages, body }) => prepareChatRequest({ messages, body }),
  });
}

/**
 * Lesbare Meldung zu einem Fehler aus `useChat`.
 *
 * Zwei Wege kommen hier an: Vor dem Stream wirft der Transport den
 * Antwort-Body als Text, also unser JSON `{ error }` — oder die HTML-Seite
 * der Plattform. Im Stream ist es der `errorText` des Servers, schon auf
 * Deutsch. Was nichts davon ist („Failed to fetch“, „An error occurred.“),
 * bekommt eine eigene Meldung statt englischem Rohtext.
 */
export function chatErrorMessage(error: Error | undefined): string {
  const raw = error?.message.trim() ?? "";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    } catch {
      // Kein gültiges JSON: unten wie unbekannter Text behandeln.
    }
    return CLIENT_MESSAGES.unknown;
  }
  // Chrome, Firefox und Safari melden einen Netzfehler jeweils anders.
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return CLIENT_MESSAGES.offline;
  }
  if (raw === "" || raw.startsWith("<") || /^an error occurred/i.test(raw) || raw.length > 300) {
    return CLIENT_MESSAGES.unknown;
  }
  return raw;
}
