import { describe, expect, it, vi } from "vitest";

import { stripControlChars } from "@/lib/text";

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
