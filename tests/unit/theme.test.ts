import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { hslTripletToHex, THEME_COLORS } from "@/lib/theme";

const globalsCss = readFileSync(
  fileURLToPath(new URL("../../app/globals.css", import.meta.url)),
  "utf8",
);

/** Liest einen HSL-Tripel aus dem `:root`-Block von `globals.css`. */
function readToken(name: string): string {
  const match = globalsCss.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match?.[1]) throw new Error(`Token --${name} fehlt in globals.css`);
  return match[1].trim();
}

describe("hslTripletToHex", () => {
  it("rechnet Primärfarben exakt", () => {
    expect(hslTripletToHex("0 100% 50%")).toBe("#ff0000");
    expect(hslTripletToHex("120 100% 50%")).toBe("#00ff00");
    expect(hslTripletToHex("240 100% 50%")).toBe("#0000ff");
  });

  it("rechnet unbunte Werte als Graustufen", () => {
    expect(hslTripletToHex("0 0% 100%")).toBe("#ffffff");
    expect(hslTripletToHex("0 0% 0%")).toBe("#000000");
  });

  it("deckt jeden Sektor des Farbkreises ab", () => {
    expect(hslTripletToHex("60 100% 50%")).toBe("#ffff00");
    expect(hslTripletToHex("180 100% 50%")).toBe("#00ffff");
    expect(hslTripletToHex("300 100% 50%")).toBe("#ff00ff");
  });

  it("wirft bei kaputtem Tripel einen klaren Fehler", () => {
    expect(() => hslTripletToHex("nur-ein-wert")).toThrow(/HSL-Tripel/);
    expect(() => hslTripletToHex("a b c")).toThrow(/nicht lesbar/);
  });
});

describe("Theme-Tokens gegen globals.css", () => {
  /**
   * Das Theme lebt in `app/globals.css`; `THEME_COLORS` existiert nur, weil
   * Meta-Tag und Manifest kein CSS lesen können. Diese Tests halten beide
   * Seiten zusammen: wer das Theme umstellt und hier vergisst, sieht es sofort.
   */
  it("THEME_COLORS.background entspricht --background", () => {
    expect(THEME_COLORS.background).toBe(hslTripletToHex(readToken("background")));
  });

  it("THEME_COLORS.foreground entspricht --foreground", () => {
    expect(THEME_COLORS.foreground).toBe(hslTripletToHex(readToken("foreground")));
  });
});

describe("globals.css", () => {
  it("definiert das Theme als CSS-Variablen — die einzige Stelle mit Farbwerten", () => {
    for (const token of [
      "background",
      "foreground",
      "card",
      "sidebar",
      "primary",
      "secondary",
      "muted",
      "accent",
      "destructive",
      "border",
      "input",
      "ring",
      "radius",
    ]) {
      expect(globalsCss, `--${token}`).toContain(`--${token}:`);
    }
  });

  it("hält die Tokens als HSL-Tripel, damit Transparenz funktioniert", () => {
    // "0 0% 100%" — kein hsl()-Wrapper, sonst könnte Tailwind
    // `bg-primary/90` nicht mehr bauen.
    expect(readToken("background")).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/);
    expect(globalsCss).toContain("hsl(var(--border))");
  });
});

describe("tailwind.config.ts", () => {
  it("verweist auf die CSS-Variablen, statt Farbwerte zu duplizieren", async () => {
    const config = (await import("../../tailwind.config")).default;
    const colors = config.theme?.extend?.colors as Record<string, unknown>;
    expect(colors.background).toBe("hsl(var(--background))");

    const primary = colors.primary as { DEFAULT: string; foreground: string };
    expect(primary.DEFAULT).toBe("hsl(var(--primary))");
    expect(primary.foreground).toBe("hsl(var(--primary-foreground))");

    // Kein einziger Hex-Wert in der Farbkonfiguration.
    expect(JSON.stringify(colors)).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it("leitet die Radien aus --radius ab", async () => {
    const config = (await import("../../tailwind.config")).default;
    const borderRadius = config.theme?.extend?.borderRadius as Record<string, string>;
    expect(borderRadius.lg).toBe("var(--radius)");
    expect(borderRadius.md).toContain("var(--radius)");
  });
});
