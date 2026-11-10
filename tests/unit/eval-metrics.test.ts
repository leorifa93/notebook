import { describe, expect, it } from "vitest";

import {
  checkThreshold,
  citationsOutOfRange,
  citesExpectedPage,
  hitsExpectedPage,
  isCleanRefusal,
  majority,
  markdownLeftovers,
  matchesExpectation,
  maxCitationsPerStatement,
  median,
} from "@/eval/metrics";
import { REFUSAL_TEXT } from "@/lib/prompt";

/**
 * Die Zählung des Evals (eval/metrics.ts). Ohne diese Tests könnte ein
 * Zählfehler eine gute oder schlechte Quote vortäuschen.
 */

const vertrag = "muster-mietvertrag";
const chunks = [
  { documentTitle: vertrag, page: 3 },
  { documentTitle: "produkthandbuch", page: 2 },
  { documentTitle: vertrag, page: null },
];

describe("hitsExpectedPage und citesExpectedPage", () => {
  it("trifft nur dieselbe Seite im selben Dokument", () => {
    expect(hitsExpectedPage(chunks, vertrag, [3])).toBe(true);
    expect(hitsExpectedPage(chunks, vertrag, [2])).toBe(false);
    expect(hitsExpectedPage(chunks, "produkthandbuch", [2, 6])).toBe(true);
  });

  it("wertet nur die tatsächlich zitierten Belege", () => {
    expect(citesExpectedPage("Drei Monate [1].", chunks, vertrag, [3])).toBe(true);
    expect(citesExpectedPage("Drei Monate [2].", chunks, vertrag, [3])).toBe(false);
    expect(citesExpectedPage("Drei Monate.", chunks, vertrag, [3])).toBe(false);
    expect(citesExpectedPage("Drei Monate [9].", chunks, vertrag, [3])).toBe(false);
  });
});

describe("citationsOutOfRange", () => {
  it("findet Nummern ohne Beleg", () => {
    expect(citationsOutOfRange("A [1]. B [5][6]. C [0].", 5)).toEqual([0, 6]);
    expect(citationsOutOfRange("A [1][2].", 5)).toEqual([]);
  });
});

describe("maxCitationsPerStatement", () => {
  it("zählt je Satz und je Zeile, nicht je Antwort", () => {
    expect(maxCitationsPerStatement("Miete 1.150 Euro [1][2]. Kaution 3.450 Euro [1].")).toBe(2);
    expect(maxCitationsPerStatement("- Hund [1]\n- Katze [1][2][3]")).toBe(3);
    expect(maxCitationsPerStatement("Ohne Beleg.")).toBe(0);
  });

  it("trennt nicht an Tausenderpunkten", () => {
    expect(maxCitationsPerStatement("Es sind 1.150 [1] und 3.450 Euro [2][3].")).toBe(3);
  });
});

describe("markdownLeftovers", () => {
  it("meldet Fettdruck, Überschriften und Sternchen-Listen", () => {
    expect(markdownLeftovers("**Miete** [1]")).toEqual(["**"]);
    expect(markdownLeftovers("## Kosten\n* Miete [1]")).toEqual(["#", "* Aufzählung"]);
  });

  it("lässt Bindestrich-Listen und Paragrafen stehen", () => {
    expect(markdownLeftovers("- Miete [1]\n- § 2 Kaution [2]")).toEqual([]);
  });
});

describe("matchesExpectation und isCleanRefusal", () => {
  it("verlangt alle erwarteten Muster", () => {
    const question = { expect: ["1\\.?150", "Euro|€"] };
    expect(matchesExpectation("Die Miete beträgt 1.150 Euro [1].", question)).toBe(true);
    expect(matchesExpectation("Die Miete beträgt 1150 € [1].", question)).toBe(true);
    expect(matchesExpectation("Die Miete beträgt 1.370 Euro [1].", question)).toBe(false);
  });

  it("wertet eine Absage mit erfundener Zahl als falsch", () => {
    const question = { forbid: ["\\d+\\s*(%|Prozent)"] };
    expect(isCleanRefusal(REFUSAL_TEXT, question)).toBe(true);
    expect(isCleanRefusal(`${REFUSAL_TEXT} Üblich sind 3 Prozent.`, question)).toBe(false);
    expect(isCleanRefusal("Die Erhöhung beträgt 3 % [1].", question)).toBe(false);
  });
});

describe("majority und median", () => {
  it("bildet den Median über drei Läufe", () => {
    expect(majority([true, false, true])).toBe(true);
    expect(majority([true, false, false])).toBe(false);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1])).toBe(2.5);
  });
});

describe("checkThreshold", () => {
  const measured = [
    { group: "answer" as const, similarity: 0.42 },
    { group: "answer" as const, similarity: 0.61 },
    { group: "refuse" as const, similarity: 0.38 },
    { group: "offtopic" as const, similarity: 0.08 },
    { group: "offtopic" as const, similarity: 0.12 },
  ];

  it("erkennt eine Schwelle in der Lücke zwischen Off-Topic und beantwortbar", () => {
    const check = checkThreshold(0.25, measured);
    expect(check.separatesOfftopic).toBe(true);
    expect(check.minAnswerable).toBeCloseTo(0.42);
    expect(check.maxOfftopic).toBeCloseTo(0.12);
    expect(check.maxMissing).toBeCloseTo(0.38);
    expect(check.gapMidpoint).toBeCloseTo(0.27);
  });

  it("meldet, wenn die Schwelle eine beantwortbare Frage absagen würde", () => {
    expect(checkThreshold(0.45, measured).separatesOfftopic).toBe(false);
    expect(checkThreshold(0.1, measured).separatesOfftopic).toBe(false);
  });
});
