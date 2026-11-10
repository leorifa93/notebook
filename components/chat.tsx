"use client";

import { useChat } from "@ai-sdk/react";
import { AlertCircle, ArrowUp, Library, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { ChatAnswer, PendingLine } from "@/components/chat-answer";
import { Button } from "@/components/ui/button";
import { MAX_QUESTION_CHARS, type ChatUIMessage } from "@/lib/chat";
import { chatErrorMessage, createChatTransport, messageText } from "@/lib/chat-client";

/**
 * Rechte Spalte: Chat über die angehakten Quellen.
 *
 * Jede Frage geht einzeln an POST /api/chat, zusammen mit der Auswahl zum
 * Zeitpunkt des Sendens (Entscheidung 3 in docs/schritt-3-plan.md). Der
 * Verlauf lebt nur hier im Browser und ist nach einem Reload weg.
 */

// TODO(Schritt 3, Commit 14): durch Fragevorschläge aus der Zusammenfassung ersetzen.
const EXAMPLE_QUESTIONS = [
  "Was ist die Kernaussage von Seite 3?",
  "Welche Fristen nennt das Dokument?",
  "Fasse die wichtigsten Punkte in fünf Sätzen zusammen.",
];

/** Ab hier zeigt der Composer, wie viele Zeichen noch gehen. */
const COUNTER_FROM = MAX_QUESTION_CHARS - 200;

interface Note {
  kind: "stopped" | "error";
  text: string;
}

interface ChatProps {
  selectedIds: readonly string[];
  totalCount: number;
  onOpenSources: () => void;
}

export function Chat({ selectedIds, totalCount, onOpenSources }: ChatProps) {
  const transport = useMemo(() => createChatTransport(), []);
  const { messages, sendMessage, status, error, stop } = useChat<ChatUIMessage>({ transport });
  const [input, setInput] = useState("");
  // Vermerke je Nachricht: angehalten oder abgebrochen. Am Verlauf und nicht
  // global, weil useChat den Fehler bei der nächsten Frage löscht; ohne
  // Vermerk sähe eine abgebrochene Antwort danach aus wie eine fertige.
  const [notes, setNotes] = useState<ReadonlyMap<string, Note>>(new Map());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const busy = status === "submitted" || status === "streaming";
  const selectedCount = selectedIds.length;
  const question = input.trim();
  const blockedReason =
    totalCount === 0
      ? "Füge links zuerst eine Quelle hinzu."
      : selectedCount === 0
        ? "Hake links mindestens eine Quelle an, damit Notebook antworten kann."
        : null;
  const canSend = !busy && blockedReason === null && question.length > 0;

  const lastMessage = messages.at(-1);
  const lastId = lastMessage?.id;
  useEffect(() => {
    if (status !== "error" || !lastId) return;
    const text = chatErrorMessage(error);
    setNotes((current) => new Map(current).set(lastId, { kind: "error", text }));
  }, [status, error, lastId]);

  // Mitscrollen, solange der Nutzer unten ist; wer hochscrollt, um einen
  // Beleg zu lesen, wird nicht zurückgerissen.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages, status]);

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    if (!canSend) return;
    stickToBottom.current = true;
    setInput("");
    void sendMessage({ text: question }, { body: { documentIds: [...selectedIds] } });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sendet, Umschalt+Enter macht eine neue Zeile. Während einer
    // IME-Eingabe bestätigt Enter nur das Zeichen.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function halt(): void {
    if (lastId) {
      setNotes((current) =>
        new Map(current).set(lastId, {
          kind: "stopped",
          text: "Angehalten – die Antwort ist unvollständig.",
        }),
      );
    }
    void stop();
  }

  function pickExample(example: string): void {
    setInput(example);
    inputRef.current?.focus();
  }

  const waitingForFirstChunk = status === "submitted" && lastMessage?.role === "user";

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-sm font-semibold leading-tight">Chat</h1>
          <p className="text-xs text-muted-foreground">
            Jede Aussage wird mit Quelle und Seite belegt.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:block">
            {totalCount === 0
              ? "Keine Quellen"
              : `${selectedCount} von ${totalCount} Quellen ausgewählt`}
          </span>
          <Button variant="outline" size="sm" className="md:hidden" onClick={onOpenSources}>
            <Library className="h-3.5 w-3.5" aria-hidden="true" />
            Quellen ({selectedCount}/{totalCount})
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto px-4 py-6 scrollbar-slim sm:px-6"
      >
        {messages.length === 0 ? (
          <EmptyState disabled={blockedReason !== null} onPick={pickExample} />
        ) : (
          <ol className="mx-auto flex w-full max-w-3xl flex-col gap-6" aria-label="Verlauf">
            {messages.map((message) => (
              <li key={message.id} className="animate-fade-in">
                {message.role === "user" ? (
                  <div className="flex justify-end">
                    <p className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                      {messageText(message)}
                    </p>
                  </div>
                ) : (
                  <ChatAnswer
                    message={message}
                    streaming={status === "streaming" && message.id === lastId}
                  />
                )}
                <MessageNote note={notes.get(message.id)} />
              </li>
            ))}
            {waitingForFirstChunk && (
              <li>
                <PendingLine label="Durchsuche die ausgewählten Quellen …" />
              </li>
            )}
          </ol>
        )}
      </div>

      <div className="border-t border-border px-4 py-4 sm:px-6">
        <form
          onSubmit={submit}
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl border border-input bg-background p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring"
        >
          <label htmlFor="chat-question" className="sr-only">
            Frage an die ausgewählten Quellen
          </label>
          <textarea
            id="chat-question"
            ref={inputRef}
            rows={1}
            value={input}
            maxLength={MAX_QUESTION_CHARS}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            aria-describedby={blockedReason ? "chat-blocked" : undefined}
            placeholder={
              totalCount === 0
                ? "Quellen zuerst hinzufügen …"
                : selectedCount === 0
                  ? "Keine Quelle angehakt …"
                  : "Frage zu den ausgewählten Quellen …"
            }
            className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-2 text-sm [field-sizing:content] placeholder:text-muted-foreground focus:outline-none"
          />
          {busy ? (
            <Button type="button" size="icon" variant="outline" onClick={halt} aria-label="Antwort anhalten">
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!canSend} aria-label="Frage senden">
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </form>
        <div className="mx-auto mt-1 flex max-w-3xl items-start justify-between gap-3 text-xs text-muted-foreground">
          {blockedReason ? (
            <p id="chat-blocked" className="flex items-center gap-2 font-medium text-foreground">
              {blockedReason}
              <button
                type="button"
                onClick={onOpenSources}
                className="underline underline-offset-2 md:hidden"
              >
                Quellen öffnen
              </button>
            </p>
          ) : (
            <p>Notebook kann Fehler machen. Prüfe Belege, bevor du dich darauf verlässt.</p>
          )}
          {input.length >= COUNTER_FROM && (
            <p className="shrink-0 tabular-nums" aria-live="polite">
              {input.length} / {MAX_QUESTION_CHARS}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function EmptyState({ disabled, onPick }: { disabled: boolean; onPick: (question: string) => void }) {
  return (
    <div className="flex h-full items-center justify-center py-4">
      <div className="w-full max-w-lg animate-fade-in">
        <div className="mb-6 flex h-10 w-10 items-center justify-center rounded-xl bg-secondary">
          <Sparkles className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <h2 className="text-balance text-xl font-semibold tracking-tight">Frag deine Dokumente</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Antworten entstehen ausschließlich aus den angehakten Quellen. Steht etwas nicht im
          Dokument, sagt Notebook das offen, statt zu raten.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          {EXAMPLE_QUESTIONS.map((example) => (
            <button
              key={example}
              type="button"
              disabled={disabled}
              onClick={() => onPick(example)}
              className="rounded-lg border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-card"
            >
              {example}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Beispielfragen – ein Klick übernimmt sie ins Eingabefeld.
        </p>
      </div>
    </div>
  );
}

function MessageNote({ note }: { note: Note | undefined }) {
  if (!note) return null;
  if (note.kind === "stopped") {
    return <p className="mt-2 text-xs text-muted-foreground">{note.text}</p>;
  }
  return (
    <div
      role="alert"
      className="mt-3 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <p>{note.text}</p>
    </div>
  );
}
