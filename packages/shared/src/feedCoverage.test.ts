import { describe, expect, it } from "bun:test";
import { coverage } from "./feedCoverage";

const M = 60_000;
const at = (min: number) => min * M;

describe("coverage", () => {
  it("is full when every minute of the window has messages", () => {
    const c = coverage([0, 1, 2, 3, 4].map(at), at(0), at(5));
    expect(c).toMatchObject({ expectedMinutes: 5, coveredMinutes: 5, ratio: 1, gaps: [] });
  });

  it("lists a run of missing minutes as a gap with its length, and counts it against the ratio", () => {
    const c = coverage([0, 1, 5, 6, 7, 8, 9].map(at), at(0), at(10));
    expect(c.coveredMinutes).toBe(7);
    expect(c.ratio).toBeCloseTo(0.7, 10);
    expect(c.gaps).toEqual([{ from: at(2), to: at(5), minutes: 3 }]);
  });

  it("catches a gap that runs to the end, and a window that starts with one", () => {
    expect(coverage([2, 3].map(at), at(0), at(6)).gaps).toEqual([{ from: at(0), to: at(2), minutes: 2 }, { from: at(4), to: at(6), minutes: 2 }]);
  });

  it("a single missing minute counts against the ratio but is not listed as a gap", () => {
    const c = coverage([0, 1, 3, 4].map(at), at(0), at(5));
    expect(c.coveredMinutes).toBe(4);
    expect(c.gaps).toEqual([]);
  });

  it("treats any instant inside a minute as that minute, cuts the window to whole minutes, and an empty window as full", () => {
    expect(coverage([at(0) + 30_000, at(1) + 5], at(0) + 10_000, at(2) + 10_000).expectedMinutes).toBe(1);
    expect(coverage([], at(5), at(5)).ratio).toBe(1);
  });
});
