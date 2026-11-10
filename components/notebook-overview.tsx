"use client";

import { AlertCircle, MessageCircleQuestion, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CitedText, PendingLine } from "@/components/chat-answer";
import { Button } from "@/components/ui/button";
import { SUMMARY_MESSAGES } from "@/lib/summary";
import { loadOverview, type OverviewState } from "@/lib/summary-client";

/**
 * Leerer Chat mit Überblick: Zusammenfassung des Notebooks mit Belegen und
 * drei Fragevorschlägen (Entscheidung 6 in docs/schritt-3-plan.md).
 *
 * Geladen wird, sobald die Quellenliste steht, und erneut, wenn sich die
 * Quellen ändern (`sourcesSignature`, nach Upload oder Löschen). Ein
 * laufender Abruf wird dann abgebrochen, damit kein alter Überblick den
 * neuen überschreibt. Fehler hier sperren den Chat nie.
 */

interface NotebookOverviewProps {
  /** Ändert sich mit jedem Upload und jedem Löschen. */
  sourcesSignature: string;
  selectedCount: number;
  onAsk: (question: string) => void;
  onOpenSources: () => void;
}

export function NotebookOverview({
  sourcesSignature,
  selectedCount,
  onAsk,
  onOpenSources,
}: NotebookOverviewProps) {
  const [state, setState] = useState<OverviewState>({ status: "loading", phase: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [needsSelection, setNeedsSelection] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", phase: "checking" });
    const apply = (next: OverviewState): void => {
      // Ein abgebrochener Abruf gehört zum alten Quellenstand.
      if (!controller.signal.aborted) setState(next);
    };
    loadOverview(fetch, { signal: controller.signal, onProgress: apply }).then(apply, () => {
      // Nur ein Abbruch landet hier; der neue Abruf setzt den Zustand selbst.
    });
    return () => controller.abort();
  }, [sourcesSignature, attempt]);

  useEffect(() => {
    if (selectedCount > 0) setNeedsSelection(false);
  }, [selectedCount]);

  const pick = useCallback(
    (question: string): void => {
      if (selectedCount === 0) {
        setNeedsSelection(true);
        return;
      }
      onAsk(question);
    },
    [selectedCount, onAsk],
  );

  return (
    <div className="flex h-full items-center justify-center py-4">
      {/* Ohne animate-fade-in: Das hinterlässt `transform`, und die auf schmalen
          Fenstern fest positionierte Belegkarte landete im Container (U6). */}
      <div className="w-full max-w-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-secondary">
            <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Überblick</h2>
            <p className="text-xs text-muted-foreground">Über alle Quellen im Notebook, mit Belegen</p>
          </div>
        </div>

        <section aria-live="polite" aria-busy={state.status === "loading"}>
          <OverviewBody state={state} onRetry={() => setAttempt((count) => count + 1)} />
        </section>

        {state.status === "ready" && (
          <div className="mt-6">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Fragen, die deine Quellen beantworten</p>
            <ul className="flex flex-col gap-2">
              {state.summary.questions.map((question) => (
                <li key={question}>
                  <button
                    type="button"
                    onClick={() => pick(question)}
                    className="flex w-full items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span>{question}</span>
                  </button>
                </li>
              ))}
            </ul>
            {needsSelection ? (
              <p role="status" className="mt-3 flex items-center gap-2 text-xs font-medium text-foreground">
                Keine Quelle angehakt. Hake links mindestens eine Quelle an, um die Frage zu stellen.
                <button type="button" onClick={onOpenSources} className="underline underline-offset-2 md:hidden">
                  Quellen öffnen
                </button>
              </p>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                Ein Klick stellt die Frage an die angehakten Quellen.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OverviewBody({ state, onRetry }: { state: OverviewState; onRetry: () => void }) {
  if (state.status === "loading") {
    return (
      <div className="space-y-3">
        <PendingLine
          label={
            state.phase === "generating"
              ? "Notebook liest deine Quellen und schreibt einen Überblick …"
              : "Überblick wird geladen …"
          }
        />
        <div className="space-y-2" aria-hidden="true">
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-3 w-4/6 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }
  if (state.status === "ready") {
    return <CitedText text={state.summary.text} citations={state.summary.citations} />;
  }
  if (state.status === "unavailable") {
    return (
      <p className="rounded-lg border border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
        {SUMMARY_MESSAGES.unavailable} Du kannst trotzdem Fragen stellen.
      </p>
    );
  }
  if (state.status === "empty") {
    return <p className="text-sm text-muted-foreground">Füge links zuerst eine Quelle hinzu.</p>;
  }
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="flex-1 space-y-2">
        <p>{state.message}</p>
        <p className="text-xs text-muted-foreground">Fragen an die Quellen gehen trotzdem.</p>
      </div>
      {state.retryable && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Erneut versuchen
        </Button>
      )}
    </div>
  );
}
