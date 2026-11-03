import { expect, test } from "bun:test";
import { HOLDOUT_FROM, ledgerCsv, simulateDay, type SimConfig } from "./eia-cfd-sim";

const cfg: SimConfig = { rPct: 0.5, delayMin: 1, slip: 0, threshold: 3 };
const AT = Date.parse("2019-03-13T14:30:00Z");
const bar = (min: number, o: number, h: number, l: number, c: number, volume = 1) => ({ time: AT / 1000 + min * 60, open: o, high: h, low: l, close: c, volume });
/** a quiet hour before the print, then the minutes after it */
const pre = Array.from({ length: 60 }, (_, i) => bar(i - 60, 70, 70.05, 69.95, 70));
const day = (after: ReturnType<typeof bar>[], over = {}) => ({ at: AT, forecast: -1, actual: -5, bars: [...pre, ...after], ...over });

test("a draw below the forecast trades ONE long, entered after the print", () => {
  const r = simulateDay(day([bar(1, 70, 70.1, 69.99, 70.05), bar(2, 70.05, 70.9, 70.0, 70.8)]), cfg);
  expect(r.status).toBe("traded");
  expect(r.side).toBe("long");
  expect(r.entryAt).toBe("14:31");
  expect(r.r).toBeGreaterThan(0);
  expect(r.rOtherSide).toBeDefined(); // the other side is computed only for the random-side test
});

test("a build above the forecast trades short; under the threshold nothing is traded", () => {
  expect(simulateDay(day([bar(1, 70, 70.01, 69.2, 69.3)], { actual: 4 }), cfg).side).toBe("short");
  expect(simulateDay(day([bar(1, 70, 70.1, 69.9, 70)], { actual: -2 }), cfg).status).toBe("no signal");
});

test("the trade is closed at the window's end: bars from 90 minutes after the print are never used", () => {
  const late = simulateDay(day([bar(1, 70, 70.05, 69.99, 70), bar(89, 70, 70.02, 69.99, 70.01), bar(91, 70, 99, 1, 99)]), cfg);
  expect(late.leg1).toContain("time");
  expect(late.leg1).not.toContain("target");
});

test("a day with no forecast, or one at or after 2022, is not simulated", () => {
  expect(simulateDay(day([], { forecast: undefined }), cfg).status).toBe("no forecast or actual");
  expect(() => simulateDay({ at: HOLDOUT_FROM, forecast: 0, actual: -5, bars: [] }, cfg)).toThrow("holdout");
});

test("the ledger is one csv row per day with a header", () => {
  const csv = ledgerCsv([simulateDay(day([bar(1, 70, 70.1, 69.99, 70.05)]), cfg)]);
  expect(csv.split("\n")).toHaveLength(2);
  expect(csv.split("\n")[0]).toStartWith("date,releaseUtc,forecast");
});

// breakout mode: the pre-print hour spans 69.95 to 70.05
const bo = (side: "surprise" | "any" = "surprise", cutoffMin = 90): SimConfig => ({ ...cfg, breakout: { candleMin: 5, cutoffMin, side } });
const quiet = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => bar(from + i, 70, 70.04, 69.96, 70));
const rising = (from: number, n: number) => Array.from({ length: n }, (_, i) => bar(from + i, 70.1 + i * 0.01, 70.2 + i * 0.01, 70.05, 70.1 + i * 0.01));

test("breakout: no entry while candles close inside the pre-print range; entry on the open after the first close above the high", () => {
  const r = simulateDay(day([...quiet(0, 10), ...rising(10, 20)]), bo());
  expect(r.status).toBe("traded");
  expect(r.side).toBe("long");
  expect(r.breakAt).toBe("14:45"); // the 5-minute candle 14:40-14:45 closed above 70.05
  expect(r.entryAt).toBe("14:45");
  expect(r.preHigh).toBe(70.05);
});

test("breakout: nothing outside the range means no trade; a close beyond the range on the wrong side of the surprise is not an entry", () => {
  expect(simulateDay(day(quiet(0, 40)), bo()).status).toBe("no breakout");
  const down = Array.from({ length: 10 }, (_, i) => bar(i, 69.9, 69.95, 69.8, 69.9)); // closes below the low, but the surprise says long
  expect(simulateDay(day(down), bo()).status).toBe("no breakout");
  const any = simulateDay(day(down), bo("any"));
  expect(any.side).toBe("short");
});

test("breakout: a break after the cutoff is ignored, and a day under the threshold is not traded in surprise mode", () => {
  expect(simulateDay(day([...quiet(0, 30), ...rising(30, 10)]), bo("surprise", 30)).status).toBe("no breakout");
  expect(simulateDay(day(rising(0, 20), { actual: -2 }), bo()).status).toBe("no signal");
});
