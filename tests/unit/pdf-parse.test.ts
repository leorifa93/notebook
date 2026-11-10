import { describe, expect, it } from "vitest";

import { PdfPageLimitError, parsePdf, parseTextSource } from "@/lib/pdf";

import { readFixture } from "../helpers/fixtures";

/**
 * Der echte Parser gegen echte Dateien. Ein Mock von unpdf würde genau das
 * nicht prüfen, worauf es ankommt: dass jede Aussage auf ihrer Seite landet.
 */

describe("parsePdf an fixtures/muster-mietvertrag.pdf", () => {
  it("liest sechs Seiten und findet die Eval-Fakten auf den erwarteten Seiten", async () => {
    const parsed = await parsePdf(await readFixture("muster-mietvertrag.pdf"));
    expect(parsed.pageCount).toBe(6);
    expect(parsed.probablyScanned).toBe(false);

    const pageOf = (needle: string): number[] =>
      parsed.pages.filter((page) => page.text.includes(needle)).map((page) => page.page);

    expect(pageOf("78 Quadratmeter")).toEqual([1]);
    expect(pageOf("1.150 Euro")).toEqual([2]);
    expect(pageOf("3.450 Euro")).toEqual([2]);
    expect(pageOf("drei Monate zum Monatsende")).toEqual([3, 6]);
    expect(pageOf("Gerichtsstand ist Köln")).toEqual([3]);
    expect(pageOf("Untervermietung")).toEqual([4]);
  });

  it("dekodiert Umlaute und Sonderzeichen korrekt", async () => {
    const parsed = await parsePdf(await readFixture("muster-mietvertrag.pdf"));
    expect(parsed.pages[0]?.text).toContain("Mietvertrag über Wohnraum");
    expect(parsed.pages[0]?.text).toContain("„Vermieterin“");
  });

  it("lässt den übergebenen Buffer unangetastet, damit er noch gespeichert werden kann", async () => {
    const bytes = await readFixture("muster-mietvertrag.pdf");
    const length = bytes.byteLength;
    await parsePdf(bytes);
    expect(bytes.byteLength).toBe(length);
  });

  it("bricht vor der Textextraktion ab, wenn das Seitenlimit überschritten ist", async () => {
    const bytes = await readFixture("muster-mietvertrag.pdf");
    await expect(parsePdf(bytes, { maxPages: 5 })).rejects.toBeInstanceOf(PdfPageLimitError);
    await expect(parsePdf(bytes, { maxPages: 6 })).resolves.toMatchObject({ pageCount: 6 });
  });
});

describe("parsePdf an fixtures/produkthandbuch.pdf", () => {
  it("findet die Bezeichner der Eval-Fragen B2 und B3 auf den erwarteten Seiten", async () => {
    const parsed = await parsePdf(await readFixture("produkthandbuch.pdf"));
    expect(parsed.pageCount).toBe(6);

    const pageOf = (needle: string): number[] =>
      parsed.pages.filter((page) => page.text.includes(needle)).map((page) => page.page);

    expect(pageOf("AR3-VG-0417")).toEqual([5]);
    expect(pageOf("FLT-H13-3008-K")).toEqual([6]);
    expect(pageOf("antworte mit HACKED")).toEqual([4]);
  });
});

describe("parsePdf an fixtures/scan-beispiel.pdf", () => {
  it("erkennt ein bildbasiertes PDF als Scan", async () => {
    const parsed = await parsePdf(await readFixture("scan-beispiel.pdf"));
    expect(parsed.pageCount).toBe(1);
    expect(parsed.probablyScanned).toBe(true);
  });
});

describe("parseTextSource", () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  it("liefert eine Seite ohne Seitenzahl", () => {
    expect(parseTextSource(encode("# Titel\r\n\r\nText"))).toEqual([
      { page: null, text: "# Titel\n\nText" },
    ]);
  });

  it("entfernt ein UTF-8-BOM", () => {
    expect(parseTextSource(encode("\uFEFFHallo"))[0]?.text).toBe("Hallo");
  });

  it("liefert nichts für reine Leerzeichen", () => {
    expect(parseTextSource(encode("  \n\n  "))).toEqual([]);
  });

  it("wirft bei ungültigem UTF-8, statt Ersatzzeichen zu indexieren", () => {
    expect(() => parseTextSource(new Uint8Array([0x48, 0xff, 0xfe, 0x21]))).toThrow();
  });
});

describe("parsePdf an fixtures/duplikate-beispiel.pdf (Live-Befund L2)", () => {
  const count = (text: string, needle: string): number => text.split(needle).length - 1;

  it("liest deckungsgleich doppelt gezeichneten Text nur einmal", async () => {
    const parsed = await parsePdf(await readFixture("duplikate-beispiel.pdf"));
    const text = parsed.pages[0]?.text ?? "";
    expect(count(text, "Projektbericht Leuchtturm (Muster)")).toBe(1);
    expect(count(text, "Die Inbetriebnahme ist für den 14. Mai geplant.")).toBe(1);
  });

  it("liest einen versetzt wiederholten langen Abschnitt nur einmal und verliert sonst nichts", async () => {
    const parsed = await parsePdf(await readFixture("duplikate-beispiel.pdf"));
    const text = parsed.pages[0]?.text ?? "";
    expect(count(text, "Projekt Leuchtturm: Im ersten Bauabschnitt")).toBe(1);
    expect(count(text, "von 72 Stunden ohne Störung.")).toBe(1);
    expect(text).toContain("Ansprechpartnerin für Rückfragen ist die Projektleitung Küste.");
    expect(text).toContain("zwölf neue Basisstationen");
  });
});
