import type { Metadata, Viewport } from "next";

import { palette } from "@/lib/palette";

import "./globals.css";

/**
 * Typography note: no `next/font/google` here on purpose. Fetching a webfont
 * at build time makes `next build` depend on network access, and this project
 * must build offline and on CI. The system stack below renders well on macOS,
 * Windows and Linux and keeps the bundle free of an extra request.
 */
export const metadata: Metadata = {
  title: "Notebook – Fragen an deine Quellen",
  description:
    "Lade Dokumente hoch und stelle Fragen. Jede Antwort stammt ausschließlich aus deinen Quellen und ist mit Seitenzahl belegt.",
};

/**
 * `themeColor` färbt die Statusleiste auf Mobilgeräten und die Titelleiste
 * einer installierten PWA. Der Wert kommt aus `lib/palette.ts` — derselben
 * Datei, aus der Tailwind seine Farbklassen baut. Kein Hex-Literal hier:
 * sonst gibt es zwei Wahrheiten für dieselbe Farbe, und die Statusleiste
 * bleibt irgendwann weiß, während die App längst anders aussieht.
 */
export const viewport: Viewport = {
  themeColor: palette.background,
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de" className="h-full">
      <body className="h-full font-sans antialiased">
        <div className="flex h-full min-h-screen flex-col">{children}</div>
      </body>
    </html>
  );
}
