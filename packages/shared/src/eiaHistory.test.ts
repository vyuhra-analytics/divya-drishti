import { describe, expect, it } from "bun:test";
import { eiaIdOf, HISTORY_SERIES, seriesContext } from "./eiaHistory";
import type { EiaPoint } from "./eia";

const WEEK = 7 * 86_400_000;
/** a weekly series ending on a Friday, oldest first */
const weekly = (values: number[], end = "2026-10-16"): EiaPoint[] =>
  values.map((value, i) => ({ period: new Date(Date.parse(`${end}T00:00:00Z`) - (values.length - 1 - i) * WEEK).toISOString().slice(0, 10), value }));

describe("seriesContext", () => {
  it("gives the level, the change on the week, four and eight weeks, and the streak of weeks moving the same way", () => {
    const c = seriesContext(weekly([100, 101, 103, 102, 100, 99, 97, 96, 94, 93]), "2026-10-16")!;
    expect(c).toMatchObject({ weeks: 10, period: "2026-10-16", level: 93, change: -1 });
    expect(c.change4w).toBe(93 - 99); // four weeks earlier the level was 99
    expect(c.change8w).toBe(93 - 101);
    expect(c.streak).toEqual({ direction: "draw", weeks: 7 }); // 103 -> 102 -> 100 -> 99 -> 97 -> 96 -> 94 -> 93: seven falls in a row
  });

  it("a build streak and a flat week are told apart", () => {
    expect(seriesContext(weekly([5, 6, 7, 9]), "2026-10-16")!.streak).toEqual({ direction: "build", weeks: 3 });
    expect(seriesContext(weekly([5, 6, 6]), "2026-10-16")!.streak).toEqual({ direction: "flat", weeks: 1 });
  });

  it("measures the week against the same week of the previous five years: average, range, position in it, and the change the season brings", () => {
    // five Octobers at 400, 410, 420, 430, 440 (the weeks before them 10 lower) and this year 415
    const pts: EiaPoint[] = [];
    for (let y = 5; y >= 1; y--) {
      const week = new Date(Date.parse("2026-10-16T00:00:00Z") - y * 364 * 86_400_000).toISOString().slice(0, 10);
      const before = new Date(Date.parse(week + "T00:00:00Z") - WEEK).toISOString().slice(0, 10);
      pts.push({ period: before, value: 400 + (5 - y) * 10 - 10 }, { period: week, value: 400 + (5 - y) * 10 });
    }
    pts.push({ period: "2026-10-09", value: 420 }, { period: "2026-10-16", value: 415 });
    const c = seriesContext(pts, "2026-10-16")!;
    expect(c.fiveYear).toMatchObject({ avg: 420, min: 400, max: 440, years: 5, vsAvg: -5 });
    expect(c.fiveYear!.vsAvgPct).toBeCloseTo(-1.2, 1);
    expect(c.fiveYear!.position).toBeCloseTo(0.38, 2);
    expect(c.seasonalChange).toEqual({ avg: 10, years: 5 });
    expect(c.yearAgo).toBe(440);
    expect(c.vsYearAgo).toBe(-25);
  });

  it("says how long ago the level was this low or this high, and the whole history when it is the extreme", () => {
    const c = seriesContext(weekly([50, 40, 60, 70, 45]), "2026-10-16")!;
    expect(c.lowestInWeeks).toBe(3); // 40 was lower, three weeks back
    expect(c.highestInWeeks).toBe(1); // 70 was higher, one week back
    expect(seriesContext(weekly([5, 6, 7]), "2026-10-16")!.highestInWeeks).toBe(3);
  });

  it("only looks at weeks up to the one asked about, and is undefined with nothing before it", () => {
    const pts = weekly([1, 2, 3, 4]);
    expect(seriesContext(pts, "2026-10-02")!.level).toBe(2); // the later weeks are not seen
    expect(seriesContext(pts, "2020-01-03")).toBeUndefined();
  });

  it("reports the period of the latest point it had, so a lagging history shows", () => {
    expect(seriesContext(weekly([1, 2, 3]), "2026-10-23")!.period).toBe("2026-10-16");
  });
});

describe("the series map", () => {
  it("has unique keys, routes and report series ids, all on EIA's weekly routes", () => {
    expect(new Set(HISTORY_SERIES.map((s) => s.key)).size).toBe(HISTORY_SERIES.length);
    expect(new Set(HISTORY_SERIES.map((s) => s.route)).size).toBe(HISTORY_SERIES.length);
    expect(new Set(HISTORY_SERIES.map((s) => s.seriesId)).size).toBe(HISTORY_SERIES.length);
    expect(HISTORY_SERIES.every((s) => s.route.endsWith(".W"))).toBe(true);
    expect(HISTORY_SERIES.filter((s) => s.unit === "MB").every((s) => s.div === 1000)).toBe(true); // EIA reports stocks in thousand barrels
    expect(eiaIdOf("PET.WCESTUS1.W")).toBe("WCESTUS1");
  });
});
