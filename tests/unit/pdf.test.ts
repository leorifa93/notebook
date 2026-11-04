import { describe, expect, it } from "vitest";
import { detectSourceType } from "@/lib/pdf";

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
