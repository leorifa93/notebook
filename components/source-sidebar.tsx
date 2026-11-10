"use client";

import { useRef, type ChangeEvent } from "react";
import { AlertCircle, FileText, Loader2, Plus, RotateCw, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { DocumentSummary } from "@/lib/documents";
import { ACCEPTED_FILE_TYPES, MAX_FILE_BYTES, MAX_PDF_PAGES, formatMegabytes } from "@/lib/limits";

/**
 * Linke Spalte: Quellen des Notebooks.
 *
 * Rein darstellend; Zustand und Requests liegen in components/workspace.tsx.
 * Vier Zustände der Liste, jeder sichtbar: lädt, Fehler, leer, fertig.
 * Upload und Fehler beim Upload stehen über der Liste, damit die Rückmeldung
 * dort erscheint, wo geklickt wurde.
 */

export type SourcesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; documents: DocumentSummary[] };

interface SourceSidebarProps {
  notebookTitle: string;
  sources: SourcesState;
  selectedIds: readonly string[];
  uploadingName: string | null;
  uploadError: string | null;
  deletingId: string | null;
  onUpload: (file: File) => void;
  onToggle: (documentId: string) => void;
  onDelete: (document: DocumentSummary) => void;
  onRetry: () => void;
  onClose: () => void;
}

const TYPE_LABELS: Record<DocumentSummary["sourceType"], string> = {
  pdf: "PDF",
  markdown: "Markdown",
  text: "Text",
};

function describe(document: DocumentSummary): string {
  const pages =
    document.sourceType === "pdf"
      ? `${document.pageCount} ${document.pageCount === 1 ? "Seite" : "Seiten"}`
      : "ohne Seiten";
  return `${TYPE_LABELS[document.sourceType]} · ${pages} · ${document.chunkCount} Abschnitte`;
}

export function SourceSidebar({
  notebookTitle,
  sources,
  selectedIds,
  uploadingName,
  uploadError,
  deletingId,
  onUpload,
  onToggle,
  onDelete,
  onRetry,
  onClose,
}: SourceSidebarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const count = sources.status === "ready" ? sources.documents.length : 0;

  const handleFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Zurücksetzen, damit dieselbe Datei nach einem Fehler erneut wählbar ist.
    event.target.value = "";
    if (file) onUpload(file);
  };

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-sidebar md:w-80 md:shrink-0">
      <div className="flex items-center gap-2 px-5 pb-4 pt-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <FileText className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">Notebook · {notebookTitle}</p>
          <p className="truncate text-xs text-muted-foreground">
            Antworten nur aus deinen Quellen
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onClose}
          aria-label="Quellen schließen"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="px-4">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={handleFile}
        />
        <Button
          className="w-full justify-start"
          disabled={uploadingName !== null || sources.status !== "ready"}
          onClick={() => inputRef.current?.click()}
        >
          {uploadingName ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Plus className="h-4 w-4" aria-hidden="true" />
          )}
          {uploadingName ? "Wird verarbeitet …" : "Quelle hinzufügen"}
        </Button>
        <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
          {uploadingName
            ? `„${uploadingName}“ wird gelesen, zerlegt und eingebettet …`
            : `PDF, Markdown oder Text · bis ${formatMegabytes(MAX_FILE_BYTES)} · PDFs bis ${MAX_PDF_PAGES} Seiten`}
        </p>
        {uploadError ? (
          <div
            role="alert"
            className="mt-2 flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{uploadError}</span>
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex items-center justify-between px-5 pb-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Quellen
        </h2>
        <Badge variant="outline">
          {sources.status === "ready" && count > 0 ? `${selectedIds.length}/${count}` : count}
        </Badge>
      </div>

      <ScrollArea className="flex-1 px-4 pb-6">
        {sources.status === "loading" ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Quellen werden geladen …
          </div>
        ) : null}

        {sources.status === "error" ? (
          <div role="alert" className="flex flex-col gap-3 rounded-lg border border-destructive/40 px-4 py-6">
            <p className="text-sm text-destructive">{sources.message}</p>
            <Button variant="outline" size="sm" className="self-start" onClick={onRetry}>
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
              Erneut laden
            </Button>
          </div>
        ) : null}

        {sources.status === "ready" && count === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center">
            <p className="text-sm font-medium">Noch keine Quellen</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Lade ein PDF hoch. Jeder Abschnitt wird mit seiner Seitenzahl
              gespeichert, damit Belege später auf die richtige Seite springen.
            </p>
          </div>
        ) : null}

        {sources.status === "ready" && count > 0 ? (
          <ul className="flex flex-col gap-1">
            {sources.documents.map((document) => {
              const checked = selectedIds.includes(document.id);
              const deleting = deletingId === document.id;
              return (
                <li
                  key={document.id}
                  className="group flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-accent"
                >
                  <input
                    id={`source-${document.id}`}
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(document.id)}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
                  />
                  <label htmlFor={`source-${document.id}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block truncate text-sm font-medium" title={document.title}>
                      {document.title}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {describe(document)}
                    </span>
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100"
                    disabled={deleting}
                    onClick={() => onDelete(document)}
                    aria-label={`„${document.title}“ entfernen`}
                  >
                    {deleting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </ScrollArea>

      <div className="border-t border-border px-5 py-4">
        <p className="text-xs text-muted-foreground">
          Demo-Instanz · keine Anmeldung nötig · höchstens 8 Uploads pro 15 Minuten
        </p>
      </div>
    </aside>
  );
}
