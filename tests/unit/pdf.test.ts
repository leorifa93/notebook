import { describe, expect, it } from "vitest";
import {
  MIN_REPEATED_BLOCK_CHARS,
  detectSourceType,
  joinTextItems,
  parseTextSource,
  removeRepeatedBlocks,
  type PdfTextItem,
} from "@/lib/pdf";

describe("detectSourceType", () => {
  it("erkennt PDFs am MIME-Typ", () => {
    expect(detectSourceType("vertrag.pdf", "application/pdf")).toBe("pdf");
  });

  it("erkennt PDFs an der Endung, wenn der Browser keinen Typ schickt", () => {
    expect(detectSourceType("VERTRAG.PDF", "application/octet-stream")).toBe("pdf");
  });

  it("erkennt Markdown", () => {
    expect(detectSourceType("notizen.md", "text/markdown")).toBe("markdown");
    expect(detectSourceType("notizen.md", "")).toBe("markdown");
  });

  it("erkennt reinen Text", () => {
    expect(detectSourceType("notizen.txt", "text/plain")).toBe("text");
  });

  it("weist Office-Dateien und Bilder ab", () => {
    expect(detectSourceType("tabelle.xlsx", "application/vnd.ms-excel")).toBe(
      "unsupported",
    );
    expect(detectSourceType("scan.png", "image/png")).toBe("unsupported");
    expect(detectSourceType("ohne-endung", "application/octet-stream")).toBe(
      "unsupported",
    );
  });
});

describe("detectSourceType: nur echter Text", () => {
  it("nimmt HTML, CSV und Quelltext nicht als Text an", () => {
    expect(detectSourceType("seite.html", "text/html")).toBe("unsupported");
    expect(detectSourceType("daten.csv", "text/csv")).toBe("unsupported");
    expect(detectSourceType("skript.js", "text/javascript")).toBe("unsupported");
  });

  it("nimmt .txt auch ohne MIME-Typ an", () => {
    expect(detectSourceType("notiz.txt", "")).toBe("text");
  });
});

describe("parseTextSource mit Steuerzeichen", () => {
  it("speichert keine NUL-Bytes aus Textdateien", () => {
    const bytes = new TextEncoder().encode("Notiz\u0000 eins");
    expect(parseTextSource(bytes)).toEqual([{ page: null, text: "Notiz eins" }]);
  });
});

describe("joinTextItems (Live-Befund L2)", () => {
  const item = (str: string, x: number, y: number, hasEOL = true): PdfTextItem => ({
    str,
    hasEOL,
    transform: [10, 0, 0, 10, x, y],
  });

  it("verwirft ein deckungsgleich zweimal gezeichnetes Stück", () => {
    expect(joinTextItems([item("Kaution", 50, 700), item("Kaution", 50, 700)])).toBe("Kaution\n");
  });

  it("toleriert Rundung unter einem Punkt", () => {
    expect(joinTextItems([item("Kaution", 50, 700), item("Kaution", 50.4, 699.7)])).toBe("Kaution\n");
  });

  it("behält gleichen Text an anderer Stelle", () => {
    expect(joinTextItems([item("Seite 1", 50, 40), item("Seite 1", 50, 60)])).toBe("Seite 1\nSeite 1\n");
  });

  it("verliert keinen Zeilenumbruch, der nur an der Kopie hängt", () => {
    const text = joinTextItems([item("Satz", 50, 700, false), item("Satz", 50, 700, true), item("Weiter", 50, 680)]);
    expect(text).toBe("Satz\nWeiter\n");
  });

  it("behält Leerstücke, sie trennen Wörter", () => {
    expect(joinTextItems([item("a", 0, 0, false), item(" ", 5, 0, false), item(" ", 5, 0, false), item("b", 9, 0)])).toBe(
      "a  b\n",
    );
  });
});

describe("removeRepeatedBlocks (Live-Befund L2)", () => {
  const block = Array.from({ length: 40 }, (_, index) => `Satz${index} über die Leitstelle.`).join(" ");

  it("entfernt die spätere Kopie eines langen Abschnitts", () => {
    expect(block.length).toBeGreaterThan(MIN_REPEATED_BLOCK_CHARS);
    expect(removeRepeatedBlocks(`Anfang ${block} Mitte ${block} Ende`)).toBe(`Anfang ${block} Mitte Ende`);
  });

  it("lässt kurze Wiederholungen stehen", () => {
    const short = "Die Kündigungsfrist beträgt drei Monate zum Monatsende.";
    const text = `${short} Dazwischen steht etwas. ${short}`;
    expect(removeRepeatedBlocks(text)).toBe(text);
  });

  it("schneidet nur an Wortgrenzen", () => {
    const result = removeRepeatedBlocks(`${block} Tech-Stack.\n${block} Team.`);
    expect(result).toBe(`${block} Tech-Stack.\nTeam.`);
  });

  it("ändert Text ohne Wiederholung nicht", () => {
    expect(removeRepeatedBlocks(block)).toBe(block);
  });
});
