import { expect, test } from "bun:test";
import { averageTankers, flowOf, parseTransits, rollingTankers, summarizeTransits, type TransitDay } from "./chokepoints";

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** `n` consecutive days ending on `end`, every day with the same tanker count */
const run = (end: string, n: number, tankers: number): TransitDay[] =>
  Array.from({ length: n }, (_, i) => ({ date: iso(Date.parse(`${end}T00:00:00Z`) - (n - 1 - i) * 86_400_000), tankers, vessels: tankers + 2, tankerCapacity: tankers * 1000 }));

test("parseTransits reads the ArcGIS features, oldest first, skipping bad rows", () => {
  const json = {
    features: [
      { attributes: { date: "2026-10-18", n_tanker: 2, n_total: 4, capacity_tanker: 19163 } },
      { attributes: { date: "2026-10-16", n_tanker: 1, n_total: 7, capacity_tanker: 68520 } },
      { attributes: { date: "2026-10-17", n_tanker: null } }, // no count
      { attributes: { n_tanker: 3 } }, // no date
    ],
  };
  const d = parseTransits(json);
  expect(d.map((x) => [x.date, x.tankers, x.vessels, x.tankerCapacity])).toEqual([["2026-10-16", 1, 7, 68520], ["2026-10-18", 2, 4, 19163]]);
  expect(parseTransits({})).toEqual([]);
});

test("averageTankers averages a calendar window and refuses a mostly empty one", () => {
  const days = run("2026-10-18", 30, 4);
  expect(averageTankers(days, "2026-10-18", 7)).toBe(4);
  expect(averageTankers(days.slice(-5), "2026-10-18", 30)).toBeUndefined(); // 5 of 30 days: not an average
});

test("summarizeTransits compares the last 30 days with the same days a year earlier", () => {
  // a year of 50 tankers a day, then 400 days later it has fallen to 2
  const days = [...run("2025-10-18", 60, 50), ...run("2026-10-18", 60, 2)];
  const s = summarizeTransits(days)!;
  expect(s.asOf).toBe("2026-10-18");
  expect(s).toMatchObject({ last: 2, avg7: 2, avg30: 2, avg30YearAgo: 50 });
  expect(s.vsYearAgoPct).toBeCloseTo(-96, 6);
  expect(s.flow).toBe("disrupted");
  expect(summarizeTransits([])).toBeUndefined();
});

test("flowOf thresholds", () => {
  expect(flowOf(-10)).toBe("normal");
  expect(flowOf(-30)).toBe("reduced");
  expect(flowOf(-69)).toBe("reduced");
  expect(flowOf(-70)).toBe("disrupted");
  expect(flowOf(undefined)).toBe("unknown");
});

test("rollingTankers gives a 7-day average from the 7th day on", () => {
  const days = run("2026-10-18", 9, 1).map((d, i) => ({ ...d, tankers: i < 7 ? 1 : 8 }));
  const r = rollingTankers(days);
  expect(r).toHaveLength(3);
  expect(r[0]).toBe(1);
  expect(r[2]).toBeCloseTo((1 * 5 + 8 * 2) / 7, 6);
});
