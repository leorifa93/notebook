/**
 * Die Farbpalette des Projekts — eine Wahrheit für alles.
 *
 * Warum hier und nicht im CSS: dieselbe Farbe wird an drei Stellen gebraucht,
 * an denen CSS nicht helfen kann. `themeColor` in den Viewport-Metadaten ist
 * ein String im TypeScript, `manifest.webmanifest` wird vom Browser gelesen,
 * bevor irgendein Stylesheet geladen ist, und Tailwind braucht die Werte für
 * seine Utility-Klassen. Ein Hex-Literal an jeder dieser Stellen wäre drei
 * Wahrheiten für eine Farbe.
 *
 * Deshalb: `tailwind.config.ts` liest diese Datei und baut daraus die Klassen
 * (`bg-background`, `text-muted-foreground`, …), das Layout liest sie für
 * `themeColor`, das Manifest für `theme_color`. Diese Datei importiert nichts
 * — sie muss auch im Tailwind-Build ohne Ladereihenfolge funktionieren.
 *
 * Der Preis: kein Umschalten des Themes zur Laufzeit mehr, wie es CSS-
 * Variablen erlauben würden. Für dieses Projekt ist das die richtige
 * Abwägung — es gibt genau ein Theme. Käme ein Dark-Mode dazu, wäre die
 * Umstellung überschaubar: Paletten pro Modus und die Klassen auf
 * `prefers-color-scheme` umstellen. Beides gehört dann bewusst zusammen
 * entschieden, statt heute eine halbe Infrastruktur dafür mitzuschleppen.
 */

export const palette = {
  background: "#ffffff",
  foreground: "#121216",

  card: "#ffffff",
  cardForeground: "#121216",

  sidebar: "#fafafc",
  sidebarForeground: "#2f2f37",

  primary: "#1c1c22",
  primaryForeground: "#fafafa",

  secondary: "#f4f4f5",
  secondaryForeground: "#1c1c22",

  muted: "#f4f4f5",
  mutedForeground: "#71717a",

  accent: "#f1f1f3",
  accentForeground: "#1c1c22",

  destructive: "#dc2828",
  destructiveForeground: "#fafafa",

  border: "#e4e4e7",
  input: "#e4e4e7",
  ring: "#1c1c22",
} as const;

/** Eckenradien, ebenfalls an einer Stelle statt als CSS-Variable. */
export const radius = {
  lg: "0.75rem",
  md: "0.625rem",
  sm: "0.5rem",
} as const;
