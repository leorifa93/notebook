import type { MetadataRoute } from "next";

import { palette } from "@/lib/palette";

/**
 * Web-Manifest.
 *
 * Hier steht dieselbe Farbe wie im Viewport des Root-Layouts — beide kommen
 * aus `lib/palette.ts`, aus der auch Tailwind seine Klassen baut. Das ist der
 * Punkt: das Manifest wird vom Browser gelesen, bevor irgendein CSS geladen
 * ist (installierte PWA, Startbildschirm). Ein eigener Hex-Wert hier wäre die
 * dritte Kopie derselben Farbe.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Notebook – Fragen an deine Quellen",
    short_name: "Notebook",
    description:
      "Lade Dokumente hoch und stelle Fragen. Jede Antwort stammt ausschließlich aus deinen Quellen und ist mit Seitenzahl belegt.",
    start_url: "/",
    display: "standalone",
    background_color: palette.background,
    theme_color: palette.background,
    lang: "de",
  };
}
