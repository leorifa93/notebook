"use client";

import type { Citation } from "@/lib/prompt";

/**
 * Beleg `[n]` im Antworttext oder als Eintrag in der Belegliste.
 *
 * Öffnet das Original in einem neuen Tab, bei PDFs auf der Seite des
 * Belegs (`#page=N`, ohne Seite kein Anker).
 */

interface CitationMarkerProps {
  citation: Citation;
  variant?: "inline" | "chip";
}

function pageLabel(page: number | null): string {
  return page === null ? "" : `, Seite ${page}`;
}

export function CitationMarker({ citation, variant = "inline" }: CitationMarkerProps) {
  const label = `Beleg ${citation.index}: ${citation.documentTitle}${pageLabel(citation.page)}`;
  if (variant === "chip") {
    return (
      <a
        href={citation.href}
        target="_blank"
        rel="noopener"
        title={label}
        className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="font-semibold tabular-nums">{citation.index}</span>
        <span className="truncate">{citation.documentTitle}</span>
        {citation.page !== null && (
          <span className="shrink-0 text-muted-foreground">S. {citation.page}</span>
        )}
      </a>
    );
  }
  return (
    <a
      href={citation.href}
      target="_blank"
      rel="noopener"
      title={label}
      aria-label={label}
      className="mx-px inline-flex min-w-[1.375rem] items-center justify-center rounded-md bg-secondary px-1 align-baseline text-xs font-semibold tabular-nums text-secondary-foreground transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {citation.index}
    </a>
  );
}
