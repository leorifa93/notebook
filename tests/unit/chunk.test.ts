import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, chunkPages, estimateTokens } from "@/lib/chunk";
import type { PdfPage } from "@/lib/pdf";

/** Baut Text mit exakt `words` Wörtern, damit Tests lesbar bleiben. */
function words(count: number, prefix = "wort"): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
}

/** Absätze mit je `wordsPerParagraph` Wörtern, getrennt durch Leerzeile. */
function paragraphs(
  count: number,
  wordsPerParagraph: number,
  prefix = "wort",
): string {
  return Array.from({ length: count }, () => words(wordsPerParagraph, prefix)).join(
    "\n\n",
  );
}

function page(number: number, text: string): PdfPage {
  return { page: number, text };
}

/** Alle Wörter eines Textes als Menge — für die Verlustfreiheits-Prüfung. */
function wordSet(text: string): Set<string> {
  return new Set(text.split(/\s+/).filter(Boolean));
}

describe("estimateTokens", () => {
  it("rechnet über Zeichen pro Token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(Math.ceil(4 / CHARS_PER_TOKEN));
  });

  it("ist monoton: längerer Text ergibt nie weniger Tokens", () => {
    const short = estimateTokens(words(10));
    const long = estimateTokens(words(50));
    expect(long).toBeGreaterThan(short);
  });
});

describe("chunkPages", () => {
  it("gibt für leere Seiten keine Chunks zurück", () => {
    expect(chunkPages([], "Titel")).toEqual([]);
    expect(chunkPages([page(1, "   \n\n  ")], "Titel")).toEqual([]);
  });

  it("nummeriert chunkIndex fortlaufend ab 0 über alle Seiten", () => {
    const pages = [
      page(1, paragraphs(3, 80)),
      page(2, paragraphs(3, 80)),
      page(3, paragraphs(3, 80)),
    ];
    const chunks = chunkPages(pages, "Vertrag");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  it("vermischt Seiten nie: ein Chunk enthält Text aus genau einer Seite", () => {
    // Jede Seite bekommt ein eigenes Wort-Präfix. Wenn ein Chunk Wörter aus
    // zwei Präfixen enthält, hat das Chunking eine Seitengrenze überschritten
    // und die Seitenzahl im Beleg wäre falsch.
    const pages = [
      page(1, paragraphs(4, 80, "seiteeins")),
      page(2, paragraphs(4, 80, "seitezwei")),
    ];
    const chunks = chunkPages(pages, "Vertrag");
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const fromFirst = chunk.content.includes("seiteeins");
      const fromSecond = chunk.content.includes("seitezwei");
      expect(fromFirst || fromSecond).toBe(true);
      expect(fromFirst && fromSecond).toBe(false);
      expect(chunk.page).toBe(fromFirst ? 1 : 2);
    }
  });

  it("behält die Seitenzahl der Herkunftsseite bei", () => {
    const pages = [page(7, paragraphs(2, 60)), page(8, paragraphs(2, 60))];
    const chunks = chunkPages(pages, "Vertrag");

    const onSeven = chunks.filter((chunk) => chunk.page === 7);
    const onEight = chunks.filter((chunk) => chunk.page === 8);
    expect(onSeven.length).toBeGreaterThan(0);
    expect(onEight.length).toBeGreaterThan(0);
  });

  it("verliert keinen Satz — auch nicht bei sehr langen Absätzen", () => {
    // Ein einzelner Absatz mit 900 Wörtern liegt über maxTokens und muss
    // satzweise geteilt werden. Genau hier ging vorher Text verloren.
    const sentences = Array.from(
      { length: 90 },
      (_, i) => `Satz${i} enthält eine Aussage zum Vertrag.`,
    ).join(" ");
    const chunks = chunkPages([page(1, sentences)], "Vertrag");

    const imChunks = wordSet(chunks.map((chunk) => chunk.content).join(" "));
    for (const word of wordSet(sentences)) {
      expect(imChunks.has(word)).toBe(true);
    }
  });

  it("hält das Token-Budget je Chunk ein", () => {
    const chunks = chunkPages([page(1, paragraphs(20, 120))], "Vertrag", {
      targetTokens: 300,
      overlapTokens: 50,
      maxTokens: 400,
    });

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(400);
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(400);
    }
  });

  it("überlappt benachbarte Chunks, damit Sätze an der Grenze vollständig bleiben", () => {
    const chunks = chunkPages([page(1, paragraphs(12, 100))], "Vertrag", {
      targetTokens: 250,
      overlapTokens: 60,
      maxTokens: 300,
    });
    expect(chunks.length).toBeGreaterThan(2);

    const [first, second] = chunks;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    const tail = first.content.split(" ").slice(-5).join(" ");
    expect(second.content).toContain(tail);
  });

  it("lässt die Überlappung weg, statt das Budget zu reißen", () => {
    const chunks = chunkPages([page(1, paragraphs(20, 120))], "Vertrag", {
      targetTokens: 200,
      overlapTokens: 150,
      maxTokens: 210,
    });

    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(210);
    }
  });

  it("setzt den Kontext-Header mit Titel und Seite", () => {
    const chunks = chunkPages([page(3, paragraphs(1, 30))], "Mietvertrag");
    expect(chunks[0]?.contextHeader).toBe("Mietvertrag · Seite 3");
  });

  it("erzeugt für ein Deckblatt mit zwei Wörtern genau einen kleinen Chunk", () => {
    const chunks = chunkPages([page(1, "Mietvertrag Müller")], "Mietvertrag");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("Mietvertrag Müller");
  });

  it("schneidet kein Wort mitten durch", () => {
    const text = words(400);
    const chunks = chunkPages([page(1, text)], "Titel", { maxTokens: 200 });

    const original = wordSet(text);
    for (const chunk of chunks) {
      for (const word of chunk.content.split(" ")) {
        if (word === "") continue;
        expect(original.has(word)).toBe(true);
      }
    }
  });

  it("ist deterministisch — gleiche Eingabe, gleiches Ergebnis", () => {
    const pages = [page(1, paragraphs(8, 90)), page(2, paragraphs(8, 90))];
    const first = chunkPages(pages, "Vertrag");
    const second = chunkPages(pages, "Vertrag");
    expect(second).toEqual(first);
  });

  it("zählt tokenCount konsistent zum Inhalt", () => {
    const chunks = chunkPages([page(1, paragraphs(5, 70))], "Vertrag");
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.content));
    }
  });
});
