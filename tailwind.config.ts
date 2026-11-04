import type { Config } from "tailwindcss";
import tailwindAnimate from "tailwindcss-animate";

import { palette, radius } from "./lib/palette";

const config: Config = {
  /*
   * Kein `darkMode: ["class"]`. Das würde Klassen wie `dark:bg-…` erzeugen,
   * die hier nichts tun — es gibt genau eine Palette und keine
   * Theme-Umschaltung. Ein Schalter, der nicht schaltet, ist schlimmer als
   * keiner: der nächste Leser sucht sonst nach dem Dark-Theme.
   */
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        // Die Werte kommen aus lib/palette.ts — derselben Datei, aus der das
        // Layout seine `themeColor` und das Manifest seine `theme_color`
        // nimmt. Kein `hsl(var(--token))` mehr: eine Farbe, eine Quelle.
        border: palette.border,
        input: palette.input,
        ring: palette.ring,
        background: palette.background,
        foreground: palette.foreground,
        primary: {
          DEFAULT: palette.primary,
          foreground: palette.primaryForeground,
        },
        secondary: {
          DEFAULT: palette.secondary,
          foreground: palette.secondaryForeground,
        },
        muted: {
          DEFAULT: palette.muted,
          foreground: palette.mutedForeground,
        },
        accent: {
          DEFAULT: palette.accent,
          foreground: palette.accentForeground,
        },
        destructive: {
          DEFAULT: palette.destructive,
          foreground: palette.destructiveForeground,
        },
        card: {
          DEFAULT: palette.card,
          foreground: palette.cardForeground,
        },
        sidebar: {
          DEFAULT: palette.sidebar,
          foreground: palette.sidebarForeground,
        },
      },
      borderRadius: {
        lg: radius.lg,
        md: radius.md,
        sm: radius.sm,
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 240ms ease-out both",
      },
    },
  },
  plugins: [tailwindAnimate],
};

export default config;
