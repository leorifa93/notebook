import type { Metadata, Viewport } from "next";

/**
 * Wurzel-Layout. Bewusst ohne `next/font/google`: ein Webfont zur Build-Zeit
 * macht `next build` von Netzwerkzugriff abhängig. Der System-Stack im
 * Tailwind-Theme reicht und spart einen zusätzlichen Request.
 */
export const metadata: Metadata = {
  title: "Notebook – Fragen an deine Quellen",
  description:
    "Lade Dokumente hoch und stelle Fragen. Jede Antwort stammt ausschließlich aus deinen Quellen und ist mit Seitenzahl belegt.",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
