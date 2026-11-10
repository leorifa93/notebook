import { ChatPlaceholder } from "@/components/chat-placeholder";
import { SourceSidebar } from "@/components/source-sidebar";

/**
 * Startseite: zweispaltiges Layout.
 *
 * Links die Quellen, rechts der Chat. In Schritt 1 sind beide Spalten
 * statisch; die Interaktion hängt später an /api/ingest und /api/chat.
 */
export default function HomePage() {
  return (
    <main className="flex h-full min-h-screen flex-col md:flex-row">
      <div className="hidden h-screen md:block">
        <SourceSidebar />
      </div>
      <div className="flex h-screen min-w-0 flex-1 flex-col">
        <ChatPlaceholder />
      </div>
    </main>
  );
}
