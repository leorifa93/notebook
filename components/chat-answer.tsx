"use client";

import { AlertTriangle, Loader2, SearchX } from "lucide-react";
import type { ReactNode } from "react";

import { CitationPopover } from "@/components/citation-popover";
import type { ChatUIMessage } from "@/lib/chat";
import { messageCitations, messageText } from "@/lib/chat-client";
import { splitCitations, splitParagraphs, type AnswerSegment } from "@/lib/citations";
import { REFUSAL_TEXT, type Citation } from "@/lib/prompt";

/**
 * Eine Antwort im Verlauf: Absätze mit Belegen `[n]` direkt an der Aussage,
 * darunter die Liste der tatsächlich zitierten Belege.
 *
 * Die Belegliste kommt laut Server vor dem ersten Wort. Fehlt sie noch,
 * läuft die Suche; ist sie da, aber noch kein Text, schreibt das Modell.
 */

interface ChatAnswerProps {
  message: ChatUIMessage;
  streaming: boolean;
}

function renderSegments(segments: readonly AnswerSegment[], citations: readonly Citation[]): ReactNode[] {
  return segments.map((segment, position) => {
    if (segment.type === "text") return <span key={position}>{segment.text}</span>;
    if (segment.type === "citation") {
      const citation = citations.find((entry) => entry.index === segment.index);
      if (citation) return <CitationPopover key={position} citation={citation} />;
    }
    const raw = segment.type === "unknown-citation" ? segment.raw : `[${segment.index}]`;
    return (
      <span
        key={position}
        className="mx-0.5 inline-flex items-center gap-0.5 rounded border border-dashed border-destructive/60 px-1 text-xs font-medium text-destructive"
        title={`Zu ${raw} gibt es in dieser Antwort keinen Beleg.`}
      >
        {raw}
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">(kein passender Beleg)</span>
      </span>
    );
  });
}

/** Belege in der Reihenfolge ihres ersten Auftretens im Text. */
function citedInOrder(text: string, citations: readonly Citation[]): Citation[] {
  const seen = new Set<number>();
  const cited: Citation[] = [];
  for (const segment of splitCitations(text, citations.length)) {
    if (segment.type !== "citation" || seen.has(segment.index)) continue;
    seen.add(segment.index);
    const citation = citations.find((entry) => entry.index === segment.index);
    if (citation) cited.push(citation);
  }
  return cited;
}

export function ChatAnswer({ message, streaming }: ChatAnswerProps) {
  const citations = messageCitations(message);
  const text = messageText(message);

  if (citations === null && text.length === 0) {
    return <PendingLine label="Durchsuche die ausgewählten Quellen …" />;
  }

  const list = citations ?? [];
  // Stufe 1 (keine Belege) und Stufe 2 (Modell sagt den Absagesatz).
  const refused = list.length === 0 || text.trimStart().startsWith(REFUSAL_TEXT);
  if (refused && text.length > 0) {
    return (
      <div className="flex gap-3 rounded-lg border border-border bg-muted/60 px-4 py-3 text-sm">
        <SearchX className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          {splitParagraphs(text).map((paragraph, index) => (
            <p key={index} className="whitespace-pre-line leading-relaxed">
              {renderSegments(splitCitations(paragraph, list.length), list)}
            </p>
          ))}
          {list.length === 0 && (
            <p className="text-xs text-muted-foreground">
              In den ausgewählten Quellen fand sich keine passende Stelle. Prüfe die Auswahl
              links oder stelle die Frage anders.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (text.length === 0) {
    return (
      <PendingLine
        label={`${list.length} ${list.length === 1 ? "passende Stelle" : "passende Stellen"} gefunden, Antwort wird formuliert …`}
      />
    );
  }

  const paragraphs = splitParagraphs(text);
  const cited = citedInOrder(text, list);

  return (
    <div className="space-y-3">
      <div className="space-y-3 text-[0.9375rem] leading-relaxed">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            {renderSegments(splitCitations(paragraph, list.length), list)}
            {streaming && index === paragraphs.length - 1 && (
              <span
                className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-foreground/60"
                aria-hidden="true"
              />
            )}
          </p>
        ))}
      </div>
      {cited.length > 0 && (
        <div className="border-t border-border pt-2">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Belege</p>
          <ul className="flex flex-wrap gap-1.5">
            {cited.map((citation) => (
              <li key={citation.index}>
                <CitationPopover citation={citation} variant="chip" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function PendingLine({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {label}
    </p>
  );
}
