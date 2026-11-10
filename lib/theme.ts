/**
 * Farben für Stellen, die kein CSS lesen können.
 *
 * `themeColor` in den Viewport-Metadaten und `theme_color` im Web-Manifest
 * sind Strings im TypeScript bzw. JSON. Sie können nicht auf
 * `hsl(var(--background))` zeigen — der Browser liest das Manifest, bevor
 * irgendein Stylesheet geladen ist, und ein `<meta>`-Tag bekommt keinen
 * CSS-Kontext.
 *
 * Deshalb steht hier ein fertiger Wert. Damit er nicht von der CSS-Variable
 * wegdriften kann, rechnet `tests/unit/theme.test.ts` `--background` aus
 * `app/globals.css` nach Hex um und vergleicht. Wer das Theme umstellt und
 * diese Datei vergisst, bekommt einen roten Test — nicht eine weiße
 * Statusleiste auf dem Handy.
 */

/** Rechnet einen HSL-Tripel aus `globals.css` (`"240 10% 8%"`) in Hex um. */
export function hslTripletToHex(triplet: string): string {
  const parts = triplet.trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(`Kein HSL-Tripel: "${triplet}"`);
  }
  const [h, s, l] = parts as [string, string, string];
  const hue = Number.parseFloat(h);
  const saturation = Number.parseFloat(s) / 100;
  const lightness = Number.parseFloat(l) / 100;

  if ([hue, saturation, lightness].some((value) => Number.isNaN(value))) {
    throw new Error(`HSL-Tripel nicht lesbar: "${triplet}"`);
  }

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const match = lightness - chroma / 2;

  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];

  const channel = (value: number) =>
    Math.round((value + match) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Dieselben Farben wie in `app/globals.css`, in einer Form, die auch ein
 * Meta-Tag oder ein Manifest versteht.
 *
 * Gepflegt wird das nicht von Hand: `tests/unit/theme.test.ts` leitet die
 * Werte aus den CSS-Tokens ab und schlägt fehl, sobald sie abweichen.
 */
export const THEME_COLORS = {
  background: "#ffffff",
  foreground: "#121216",
} as const;
