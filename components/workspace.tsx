"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ChatPlaceholder } from "@/components/chat-placeholder";
import { SourceSidebar, type SourcesState } from "@/components/source-sidebar";
import type { DocumentSummary, NotebookSummary } from "@/lib/documents";
import { MAX_FILE_BYTES, formatMegabytes } from "@/lib/limits";

/**
 * Client-Zustand der Startseite: Quellenliste, Auswahl, Upload, Löschen.
 *
 * Die Auswahl lebt hier und nicht in der Sidebar, weil der Chat in Schritt 3
 * genau diese IDs als `documentIds` an /api/chat schickt. Gespeichert werden
 * die *abgewählten* IDs: Eine neu hochgeladene Quelle ist damit automatisch
 * ausgewählt, ohne dass jemand daran denken muss.
 */

interface ListResponse {
  notebook: NotebookSummary;
  documents: DocumentSummary[];
}

/**
 * Fehlermeldung aus einer Antwort lesen. Nicht jede Antwort ist unser JSON:
 * Vercel schneidet zu große Bodies selbst mit einer HTML-Seite ab.
 */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Kein JSON, dann bleibt die Meldung nach Status unten.
  }
  if (response.status === 413) {
    return `Die Datei ist zu groß. Erlaubt sind höchstens ${formatMegabytes(MAX_FILE_BYTES)}.`;
  }
  return `Unerwarteter Fehler (Status ${response.status}). Bitte versuche es erneut.`;
}

export function Workspace() {
  const [sources, setSources] = useState<SourcesState>({ status: "loading" });
  const [notebook, setNotebook] = useState<NotebookSummary | null>(null);
  const [excludedIds, setExcludedIds] = useState<ReadonlySet<string>>(new Set());
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const loadSources = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/documents", { cache: "no-store" });
      if (!response.ok) {
        setSources({ status: "error", message: await errorMessage(response) });
        return;
      }
      const body = (await response.json()) as ListResponse;
      setNotebook(body.notebook);
      setSources({ status: "ready", documents: body.documents });
    } catch {
      setSources({
        status: "error",
        message: "Die Quellen konnten nicht geladen werden. Besteht eine Verbindung?",
      });
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const upload = useCallback(
    async (file: File): Promise<void> => {
      setUploadError(null);
      // Vorab prüfen: Auf Vercel käme eine zu große Datei sonst als 413 der
      // Plattform an, ohne unsere Meldung.
      if (file.size > MAX_FILE_BYTES) {
        setUploadError(
          `„${file.name}“ ist zu groß. Erlaubt sind höchstens ${formatMegabytes(MAX_FILE_BYTES)}.`,
        );
        return;
      }
      setUploading(file.name);
      try {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/ingest", { method: "POST", body: form });
        if (!response.ok) {
          setUploadError(await errorMessage(response));
          return;
        }
        await loadSources();
      } catch {
        setUploadError("Der Upload ist abgebrochen. Besteht eine Verbindung?");
      } finally {
        setUploading(null);
      }
    },
    [loadSources],
  );

  const remove = useCallback(
    async (document: DocumentSummary): Promise<void> => {
      if (!window.confirm(`„${document.title}“ aus dem Notebook entfernen?`)) return;
      setDeletingId(document.id);
      setUploadError(null);
      try {
        const response = await fetch(`/api/documents/${document.id}`, { method: "DELETE" });
        // 404 heißt: schon weg, etwa aus einem zweiten Tab. Liste trotzdem auffrischen.
        if (!response.ok && response.status !== 404) {
          setUploadError(await errorMessage(response));
          return;
        }
        setExcludedIds((current) => {
          const next = new Set(current);
          next.delete(document.id);
          return next;
        });
        await loadSources();
      } catch {
        setUploadError("Die Quelle konnte nicht entfernt werden. Besteht eine Verbindung?");
      } finally {
        setDeletingId(null);
      }
    },
    [loadSources],
  );

  const toggle = useCallback((documentId: string): void => {
    setExcludedIds((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }, []);

  const documents = useMemo(
    () => (sources.status === "ready" ? sources.documents : []),
    [sources],
  );
  // TODO(Schritt 3): selectedIds als `documentIds` an POST /api/chat schicken.
  const selectedIds = useMemo(
    () => documents.filter((document) => !excludedIds.has(document.id)).map((d) => d.id),
    [documents, excludedIds],
  );

  return (
    <main className="flex h-full min-h-screen flex-col md:flex-row">
      <div
        className={
          sourcesOpen
            ? "fixed inset-0 z-40 flex bg-background md:static md:z-auto md:h-screen"
            : "hidden h-screen md:flex"
        }
      >
        <SourceSidebar
          notebookTitle={notebook?.title ?? "Demo"}
          sources={sources}
          selectedIds={selectedIds}
          uploadingName={uploading}
          uploadError={uploadError}
          deletingId={deletingId}
          onUpload={upload}
          onToggle={toggle}
          onDelete={remove}
          onRetry={loadSources}
          onClose={() => setSourcesOpen(false)}
        />
      </div>
      <div className="flex h-screen min-w-0 flex-1 flex-col">
        <ChatPlaceholder
          selectedCount={selectedIds.length}
          totalCount={documents.length}
          onOpenSources={() => setSourcesOpen(true)}
        />
      </div>
    </main>
  );
}
