import { describe, expect, it } from "bun:test";
import { labelAgreement, LABEL_KEYS, parseLabelInput, type Label } from "./labelling";

describe("a label request", () => {
  it("accepts a whole request and a minimal one", () => {
    expect(parseLabelInput({ sampleId: 12, labeler: "owner", label: "bullish", afterMove: true, note: " tankers " })).toEqual({ sampleId: 12, labeler: "owner", label: "bullish", afterMove: true, note: "tankers" });
    expect(parseLabelInput({ sampleId: 1, labeler: "claude", label: "not_crude" })).toEqual({ sampleId: 1, labeler: "claude", label: "not_crude", afterMove: false, note: undefined });
  });

  it("refuses everything else", () => {
    const ok = { sampleId: 1, labeler: "owner", label: "bullish" };
    for (const bad of [{ ...ok, sampleId: 0 }, { ...ok, sampleId: 1.5 }, { ...ok, sampleId: "1" }, { ...ok, labeler: "has space" }, { ...ok, labeler: "" }, { ...ok, label: "positive" }, { ...ok, afterMove: "yes" }, { ...ok, note: "x".repeat(301) }, null, "x"])
      expect("error" in parseLabelInput(bad)).toBe(true);
  });

  it("the keys 1 to 4 are the four labels in order", () => {
    expect(Object.values(LABEL_KEYS)).toEqual(["bullish", "bearish", "neutral", "not_crude"]);
  });
});

describe("labelAgreement between two labelers", () => {
  const m = (pairs: [string, Label][]) => new Map(pairs);

  it("is perfect for identical labels and counts only the items both labeled", () => {
    const a = m([["1", "bullish"], ["2", "bearish"], ["3", "neutral"], ["4", "bullish"]]);
    const r = labelAgreement(a, m([["1", "bullish"], ["2", "bearish"], ["3", "neutral"], ["9", "bearish"]]))!;
    expect(r.n).toBe(3);
    expect(r.accuracy).toBe(1);
    expect(r.kappa).toBe(1);
  });

  it("works kappa out against chance: a labeler who always says neutral has high accuracy on a neutral-heavy set and kappa 0", () => {
    const a = m([...Array.from({ length: 8 }, (_, i) => [`n${i}`, "neutral"] as [string, Label]), ["b1", "bullish"], ["b2", "bearish"]]);
    const always = new Map<string, Label>([...a.keys()].map((k) => [k, "neutral"]));
    const r = labelAgreement(a, always)!;
    expect(r.accuracy).toBeCloseTo(0.8, 10);
    expect(r.kappa).toBeCloseTo(0, 10);
  });

  it("puts the disagreements in the confusion matrix and gives negative kappa for systematic disagreement", () => {
    const a = m([["1", "bullish"], ["2", "bullish"], ["3", "bearish"], ["4", "bearish"]]);
    const b = m([["1", "bearish"], ["2", "bearish"], ["3", "bullish"], ["4", "bullish"]]);
    const r = labelAgreement(a, b)!;
    expect(r.confusion.bullish.bearish).toBe(2);
    expect(r.confusion.bearish.bullish).toBe(2);
    expect(r.kappa).toBeLessThan(0);
  });

  it("is undefined when they share nothing", () => expect(labelAgreement(m([["1", "bullish"]]), m([["2", "bullish"]]))).toBeUndefined());
});
