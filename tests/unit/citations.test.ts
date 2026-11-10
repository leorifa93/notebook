import { describe, expect, it } from "vitest";

import { splitCitations, splitParagraphs } from "@/lib/citations";

describe("splitCitations", () => {
  it("macht aus [n] innerhalb der Belegliste einen Beleg", () => {
    expect(splitCitations("Die Kaution beträgt 3.450 Euro [1].", 5)).toEqual([
      { type: "text", text: "Die Kaution beträgt 3.450 Euro " },
      { type: "citation", index: 1 },
      { type: "text", text: "." },
    ]);
  });

  it("trennt direkt aufeinanderfolgende Belege [1][2]", () => {
    expect(splitCitations("Miete [1][2]", 2)).toEqual([
      { type: "text", text: "Miete " },
      { type: "citation", index: 1 },
      { type: "citation", index: 2 },
    ]);
  });

  it("liest [12] als zwölf, nicht als [1] und [2]", () => {
    expect(splitCitations("Siehe [12].", 12)).toEqual([
      { type: "text", text: "Siehe " },
      { type: "citation", index: 12 },
      { type: "text", text: "." },
    ]);
    expect(splitCitations("Siehe [12].", 5)[1]).toEqual({
      type: "unknown-citation",
      raw: "[12]",
      index: 12,
    });
  });

  it("markiert [n] außerhalb der Liste, statt es zu verlieren", () => {
    const segments = splitCitations("Erfunden [7], echt [5], null [0].", 5);
    expect(segments).toEqual([
      { type: "text", text: "Erfunden " },
      { type: "unknown-citation", raw: "[7]", index: 7 },
      { type: "text", text: ", echt " },
      { type: "citation", index: 5 },
      { type: "text", text: ", null " },
      { type: "unknown-citation", raw: "[0]", index: 0 },
      { type: "text", text: "." },
    ]);
  });

  it("markiert jedes [n], wenn die Belegliste leer ist (Absage)", () => {
    expect(splitCitations("Das steht nicht drin [1].", 0)[1]).toMatchObject({
      type: "unknown-citation",
    });
  });

  it("lässt [a], [1, 2], [] und ein offenes [3 als Text stehen", () => {
    const text = "Liste [a] und [1, 2] und [] und gerade getippt [3";
    expect(splitCitations(text, 5)).toEqual([{ type: "text", text }]);
  });

  it("liefert Text ohne Belege unverändert und leeren Text als leere Liste", () => {
    expect(splitCitations("Kein Beleg.", 3)).toEqual([{ type: "text", text: "Kein Beleg." }]);
    expect(splitCitations("", 3)).toEqual([]);
  });

  it("verliert kein Zeichen: Zusammensetzen ergibt den Originaltext", () => {
    const text = "A [1]\n\nB [9][2] C [x] [3]";
    const joined = splitCitations(text, 3)
      .map((segment) => (segment.type === "text" ? segment.text : segment.type === "citation" ? `[${segment.index}]` : segment.raw))
      .join("");
    expect(joined).toBe(text);
  });
});

describe("splitParagraphs", () => {
  it("trennt an Leerzeilen und behält einfache Umbrüche im Absatz", () => {
    expect(splitParagraphs("Erster Satz [1].\nZweite Zeile.\n\n  \nZweiter Absatz [2].")).toEqual([
      "Erster Satz [1].\nZweite Zeile.",
      "Zweiter Absatz [2].",
    ]);
  });

  it("ignoriert Leerraum am Rand und liefert für leeren Text nichts", () => {
    expect(splitParagraphs("\n\nNur einer.\n\n")).toEqual(["Nur einer."]);
    expect(splitParagraphs("   ")).toEqual([]);
  });
});
