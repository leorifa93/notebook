import type { MetadataRoute } from "next";

import { THEME_COLORS } from "@/lib/theme";

/**
 * Web-Manifest.
 *
 * Das Manifest wird vom Browser gelesen, bevor CSS geladen ist (installierte
 * PWA, Startbildschirm) — hier funktioniert `var(--background)` also nicht.
 * Die Werte kommen aus `lib/theme.ts` und werden dort per Test gegen die
 * CSS-Tokens abgeglichen.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Notebook – Fragen an deine Quellen",
    short_name: "Notebook",
    description:
      "Lade Dokumente hoch und stelle Fragen. Jede Antwort stammt ausschließlich aus deinen Quellen und ist mit Seitenzahl belegt.",
    start_url: "/",
    display: "standalone",
    background_color: THEME_COLORS.background,
    theme_color: THEME_COLORS.background,
    lang: "de",
  };
}
