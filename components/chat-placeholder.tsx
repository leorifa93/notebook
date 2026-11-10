"use client";

import { ArrowUp, Library, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Rechte Spalte: Chat.
 *
 * Bis Schritt 3 der leere Zustand mit drei Beispiel-Fragen und einem
 * deaktivierten Composer. Der echte Verlauf kommt über POST /api/chat
 * (streaming, siehe app/api/chat/route.ts). Schon jetzt sichtbar: wie viele
 * Quellen ausgewählt sind, und auf schmalen Fenstern der Weg zur Sidebar.
 */
const EXAMPLE_QUESTIONS = [
  "Was ist die Kernaussage von Seite 3?",
  "Welche Fristen nennt das Dokument?",
  "Fasse die wichtigsten Punkte in fünf Sätzen zusammen.",
];

interface ChatPlaceholderProps {
  selectedCount: number;
  totalCount: number;
  onOpenSources: () => void;
}

export function ChatPlaceholder({ selectedCount, totalCount, onOpenSources }: ChatPlaceholderProps) {
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
            Quellen ({totalCount})
          </Button>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-10 scrollbar-slim">
        <div className="w-full max-w-lg animate-fade-in">
          <div className="mb-6 flex h-10 w-10 items-center justify-center rounded-xl bg-secondary">
            <Sparkles className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <h2 className="text-balance text-xl font-semibold tracking-tight">
            Frag deine Dokumente
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Antworten entstehen ausschließlich aus den hochgeladenen Quellen.
            Steht etwas nicht im Dokument, sagt Notebook das offen, statt zu
            raten.
          </p>

          <div className="mt-6 flex flex-col gap-2">
            {EXAMPLE_QUESTIONS.map((question) => (
              <button
                key={question}
                type="button"
                disabled
                className="rounded-lg border border-border bg-card px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:hover:bg-card"
              >
                {question}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Beispielfragen – aktiv, sobald der Chat steht (Schritt 3).
          </p>
        </div>
      </div>

      <div className="border-t border-border px-6 py-4">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl border border-input bg-background p-2 shadow-sm">
          <textarea
            rows={1}
            disabled
            placeholder={
              totalCount === 0 ? "Quellen zuerst hinzufügen …" : "Chat folgt in Schritt 3 …"
            }
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
          />
          <Button size="icon" disabled aria-label="Frage senden">
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        <p className="mx-auto mt-1 max-w-3xl text-center text-xs text-muted-foreground">
          Notebook kann Fehler machen. Prüfe Belege, bevor du dich darauf
          verlässt.
        </p>
      </div>
    </section>
  );
}
