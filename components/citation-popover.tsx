"use client";

import { ExternalLink, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { popoverPlacement, type Placement } from "@/lib/citations";
import type { Citation } from "@/lib/prompt";
import { cn } from "@/lib/utils";

/**
 * Beleg `[n]` mit Karte: Titel, Seite, Ausschnitt und Sprung ins Original.
 *
 * Bewusst ohne Popover-Bibliothek: Es gibt hier genau eine Karte, die unter
 * oder über dem Beleg aufklappt (lib/citations.ts entscheidet die Seite) und
 * auf schmalen Fenstern als Leiste am unteren Rand liegt. Tastatur: Enter
 * oder Leertaste öffnet (nativer Button), Escape schließt und gibt den
 * Fokus an den Beleg zurück, Fokus außerhalb oder ein Klick daneben
 * schließt ebenfalls.
 */

interface CitationPopoverProps {
  citation: Citation;
  /** `inline` im Antworttext, `chip` in der Belegliste unter der Antwort. */
  variant?: "inline" | "chip";
}

const PLACEMENT_CLASSES: Record<Placement["vertical"] | Placement["horizontal"], string> = {
  below: "sm:top-full sm:mt-1.5",
  above: "sm:bottom-full sm:mb-1.5",
  start: "sm:left-0",
  end: "sm:right-0",
};

export function CitationPopover({ citation, variant = "inline" }: CitationPopoverProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>({ horizontal: "start", vertical: "below" });
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const cardId = useId();

  const page = citation.page === null ? "" : `, Seite ${citation.page}`;
  const label = `Beleg ${citation.index}: ${citation.documentTitle}${page}`;

  useEffect(() => {
    if (!open) return;
    cardRef.current?.focus();
    const closeOnOutside = (event: PointerEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [open]);

  function toggle(): void {
    if (open) {
      setOpen(false);
      return;
    }
    const trigger = triggerRef.current;
    if (trigger) {
      setPlacement(
        popoverPlacement(trigger.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    }
    setOpen(true);
  }

  function close(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>): void {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      close();
    }
  }

  return (
    <span
      ref={wrapperRef}
      className="relative inline-block"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!wrapperRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={variant === "inline" ? label : undefined}
        title={label}
        className={cn(
          "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          variant === "inline"
            ? "mx-px inline-flex min-w-[1.375rem] items-center justify-center rounded-md bg-secondary px-1 align-baseline text-xs font-semibold tabular-nums text-secondary-foreground hover:bg-primary hover:text-primary-foreground"
            : "inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs hover:bg-accent",
          open && variant === "inline" && "bg-primary text-primary-foreground",
          open && variant === "chip" && "bg-accent",
        )}
      >
        {variant === "inline" ? (
          citation.index
        ) : (
          <>
            <span className="font-semibold tabular-nums">{citation.index}</span>
            <span className="truncate">{citation.documentTitle}</span>
            {citation.page !== null && (
              <span className="shrink-0 text-muted-foreground">S. {citation.page}</span>
            )}
          </>
        )}
      </button>

      {open && (
        <span
          ref={cardRef}
          id={cardId}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className={cn(
            "fixed bottom-3 left-3 right-3 z-50 block animate-fade-in rounded-lg border border-border bg-card p-4 text-left text-sm font-normal text-card-foreground shadow-lg focus:outline-none",
            // Auf schmalen Fenstern unten fest, ab `sm` am Beleg. Die Klassen aus
            // PLACEMENT_CLASSES ersetzen per tailwind-merge die `auto`-Werte.
            "sm:absolute sm:bottom-auto sm:left-auto sm:right-auto sm:w-80",
            PLACEMENT_CLASSES[placement.vertical],
            PLACEMENT_CLASSES[placement.horizontal],
          )}
        >
          <span className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-xs font-medium text-muted-foreground">
                Beleg {citation.index}
                {citation.page !== null ? ` · Seite ${citation.page}` : " · ohne Seitenangabe"}
              </span>
              <span className="mt-0.5 block break-words font-semibold leading-snug">
                {citation.documentTitle}
              </span>
            </span>
            <button
              type="button"
              onClick={close}
              aria-label="Beleg schließen"
              className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </span>
          <span className="mt-3 block max-h-48 overflow-y-auto border-l-2 border-border pl-3 leading-relaxed text-foreground/90 scrollbar-slim">
            „{citation.snippet}“
          </span>
          <a
            href={citation.href}
            target="_blank"
            rel="noopener"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Im Original öffnen{page}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </span>
      )}
    </span>
  );
}
