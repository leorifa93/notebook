import { FileText, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * Linke Spalte: Quellenliste.
 *
 * Schritt 1 zeigt nur den leeren Zustand. Die Liste wird später aus
 * `documents` (siehe db/schema.sql) geladen; der Upload-Button hängt dann an
 * POST /api/ingest. Bis dahin sind beide bewusst deaktiviert, damit niemand
 * auf einen Knopf drückt, der noch nichts tut.
 */
export function SourceSidebar() {
  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-sidebar md:w-80 md:shrink-0">
      <div className="flex items-center gap-2 px-5 pb-4 pt-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <FileText className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">Notebook</p>
          <p className="truncate text-xs text-muted-foreground">
            Antworten nur aus deinen Quellen
          </p>
        </div>
      </div>

      <div className="px-4">
        <Button className="w-full justify-start" disabled>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Quelle hinzufügen
        </Button>
        <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
          PDF-Upload folgt in Schritt 2.
        </p>
      </div>

      <div className="mt-6 flex items-center justify-between px-5 pb-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Quellen
        </h2>
        <Badge variant="outline">0</Badge>
      </div>

      <ScrollArea className="flex-1 px-4 pb-6">
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm font-medium">Noch keine Quellen</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Lade ein PDF hoch. Jeder Abschnitt wird mit seiner Seitenzahl
            gespeichert, damit Belege später auf die richtige Seite springen.
          </p>
        </div>
      </ScrollArea>

      <div className="border-t border-border px-5 py-4">
        <p className="text-xs text-muted-foreground">
          Demo-Instanz · keine Anmeldung nötig
        </p>
      </div>
    </aside>
  );
}
