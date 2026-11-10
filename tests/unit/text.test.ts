import { describe, expect, it, vi } from "vitest";

import { cleanText, stripControlChars } from "@/lib/text";

describe("stripControlChars", () => {
  it("entfernt NUL-Bytes, die Postgres in text ablehnt", () => {
    expect(stripControlChars("Lebens\u0000lauf")).toBe("Lebenslauf");
  });

  it("entfernt weitere C0-Steuerzeichen und DEL", () => {
    expect(stripControlChars("a\u0001b\u001Fc\u007Fd\u000Be")).toBe("abcde");
  });

  it("lässt Zeilenumbruch, Tab und Umlaute stehen", () => {
    expect(stripControlChars("Größe\tÜbersicht\nZeile")).toBe("Größe\tÜbersicht\nZeile");
  });
});

describe("cleanText", () => {
  it("entfernt weiches Trennzeichen, Nullbreiten-Leerzeichen, Wortverbinder und ein BOM mitten im Text", () => {
    expect(cleanText("Lebens\u200Blauf, Aus\u00ADbildung, Kaution\u2060s\uFEFFbetrag")).toBe(
      "Lebenslauf, Ausbildung, Kautionsbetrag",
    );
  });

  it("fügt ein Wort mit weichem Trennzeichen am Zeilenende wieder zusammen", () => {
    expect(cleanText("Aus\u00AD\nbildung")).toBe("Ausbildung");
  });

  it("setzt zerlegte Umlaute zusammen (NFC), lässt aber m² und Emoji stehen", () => {
    expect(cleanText("Gro\u0308ße 80 m² 👨\u200D👩\u200D👧")).toBe("Größe 80 m² 👨\u200D👩\u200D👧");
  });

  it("entfernt einzelne Surrogate, behält aber Paare", () => {
    expect(cleanText("Haus \uD800🏠")).toBe("Haus 🏠");
  });
});

/**
 * F4 aus dem frischen Review: Der Chat brauchte aus lib/pdf.ts nur die Regex,
 * zog damit aber `unpdf` (und lazy pdf.js) in das Bundle seiner Route.
 * Ist `unpdf` hier unladbar, muss die Chat-Route trotzdem importierbar sein.
 */
describe("Chat-Route ohne PDF-Bibliothek", () => {
  it("lädt den Chat-Handler, ohne unpdf zu importieren", async () => {
    vi.resetModules();
    vi.doMock("unpdf", () => {
      throw new Error("unpdf gehört nicht in die Chat-Route");
    });
    try {
      await expect(import("@/app/api/chat/handler")).resolves.toHaveProperty("handleChat");
    } finally {
      vi.doUnmock("unpdf");
      vi.resetModules();
    }
  });
});
