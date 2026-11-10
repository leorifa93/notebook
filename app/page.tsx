import { Workspace } from "@/components/workspace";

/**
 * Startseite: zweispaltiges Layout, links Quellen, rechts Chat.
 *
 * Der Zustand (Quellenliste, Auswahl, Upload) lebt in der Client-Komponente
 * `Workspace`; die Seite selbst bleibt ein Server-Component ohne Datenzugriff.
 */
export default function HomePage() {
  return <Workspace />;
}
