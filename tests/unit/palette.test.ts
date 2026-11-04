import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { palette, radius } from "@/lib/palette";
import tailwindConfig from "../../tailwind.config";

const globalsCss = readFileSync(
  fileURLToPath(new URL("../../app/globals.css", import.meta.url)),
  "utf8",
);

/**
 * Diese Tests halten die eine Regel fest, um die es im Review ging: es gibt
 * genau eine Quelle für eine Farbe. Sie prüfen nicht, ob eine Farbe "schön"
 * ist, sondern ob Tailwind, Layout und Manifest weiterhin dieselbe benutzen —
 * und ob niemand eine zweite Wahrheit danebenlegt.
 */

describe("palette", () => {
  it("nutzt ausschließlich Hex-Werte", () => {
    for (const [name, value] of Object.entries(palette)) {
      expect(value, `palette.${name}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("hält Vordergrund- und Hintergrundfarben unterscheidbar", () => {
    expect(palette.background).not.toBe(palette.foreground);
    expect(palette.primary).not.toBe(palette.primaryForeground);
    expect(palette.muted).not.toBe(palette.mutedForeground);
  });
});

describe("globals.css", () => {
  it("definiert keine Farb-Variablen mehr — die Palette ist die einzige Quelle", () => {
    expect(globalsCss).not.toMatch(/--(background|foreground|primary|muted|border|ring|card|sidebar|accent|secondary|destructive)\s*:/);
  });

  it("holt Scrollbar-Farben aus dem Tailwind-Theme statt aus einer Variable", () => {
    expect(globalsCss).toContain("theme(colors.border)");
    expect(globalsCss).not.toContain("hsl(var(--border))");
  });
});

describe("tailwind.config.ts", () => {
  it("baut die Farbklassen aus der Palette, nicht aus CSS-Variablen", () => {
    const colors = tailwindConfig.theme?.extend?.colors as
      | Record<string, string | { DEFAULT: string; foreground: string }>
      | undefined;
    expect(colors).toBeDefined();
    if (!colors) return;

    expect(colors.background).toBe(palette.background);
    expect(colors.foreground).toBe(palette.foreground);
    expect(colors.border).toBe(palette.border);

    const primary = colors.primary as { DEFAULT: string; foreground: string };
    expect(primary.DEFAULT).toBe(palette.primary);
    expect(primary.foreground).toBe(palette.primaryForeground);

    // Der eigentliche Regressionsschutz: kein `hsl(var(--…))` mehr.
    for (const value of JSON.stringify(colors).match(/"#[^"]+"/g) ?? []) {
      expect(value).toMatch(/^"#[0-9a-f]{6}"$/);
    }
    expect(JSON.stringify(colors)).not.toContain("var(--");
  });

  it("nimmt die Radien aus derselben Datei", () => {
    const borderRadius = tailwindConfig.theme?.extend?.borderRadius as
      | Record<string, string>
      | undefined;
    expect(borderRadius?.lg).toBe(radius.lg);
    expect(borderRadius?.md).toBe(radius.md);
    expect(borderRadius?.sm).toBe(radius.sm);
  });
});
