import { describe, expect, it } from "bun:test";
import { rangeDrawings } from "./advStrategyLevels";

describe("rangeDrawings", () => {
  const blue = "#42a5f5";
  it("draws a range's high and low as one shaded box from the start of its hour to the latest bar, with the numbers in its label", () => {
    const d = rangeDrawings({ "reportday:range": [{ price: 9756, title: "Range high", color: blue, from: 1000 }, { price: 9678, title: "Range low", color: blue, from: 1000 }] }, 5000);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "box", from: { time: 1000, price: 9756 }, to: { time: 5000, price: 9678 } });
    expect((d[0] as { text: string }).text).toBe("Range high 9756\nRange low 9678"); // one line each: a narrow box would cut a long single line
  });

  it("draws a single level with a start as a line from that time, and leaves out levels with no start (they stay full-width price lines)", () => {
    const d = rangeDrawings({ a: [{ price: 100, title: "x", color: blue, from: 1000 }], b: [{ price: 50, title: "entry", color: blue }] }, 5000);
    expect(d).toEqual([{ kind: "line", from: { time: 1000, price: 100 }, to: { time: 5000, price: 100 }, color: blue, lineWidth: 1, lineStyle: "solid" }]);
  });

  it("draws nothing before the range has started or without bars", () => {
    expect(rangeDrawings({ a: [{ price: 1, title: "x", color: blue, from: 9000 }] }, 5000)).toEqual([]);
    expect(rangeDrawings({ a: [{ price: 1, title: "x", color: blue, from: 1000 }] }, undefined)).toEqual([]);
  });
});
