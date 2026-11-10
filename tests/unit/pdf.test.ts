import { describe, expect, it } from "vitest";
import { detectSourceType, parseTextSource } from "@/lib/pdf";

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
