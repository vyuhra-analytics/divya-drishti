import { expect, test } from "bun:test";
import { barCloseTime, barProblem, completedBars, quoteProblem, validateBars } from "./bars";
import { normalizeBars, parseUpstoxCandles, type Bar, type Quote } from "./index";

const ok: Bar = { time: 1_760_000_000, open: 100, high: 105, low: 98, close: 103, volume: 10 };

test("barProblem accepts a consistent bar and names each way a bar can be impossible", () => {
  expect(barProblem(ok)).toBeUndefined();
  expect(barProblem({ ...ok, open: 98, high: 98, low: 98, close: 98 })).toBeUndefined(); // a flat bar is fine
  expect(barProblem({ ...ok, high: 99 })).toMatch(/high is below/);
  expect(barProblem({ ...ok, low: 101 })).toMatch(/low is above/);
  expect(barProblem({ ...ok, close: NaN })).toMatch(/close is not a number/);
  expect(barProblem({ ...ok, open: 0 })).toMatch(/open is not positive/);
  expect(barProblem({ ...ok, volume: -1 })).toMatch(/volume/);
  expect(barProblem({ ...ok, time: 1.5 })).toMatch(/time/);
  expect(barProblem({ ...ok, time: NaN })).toMatch(/time/);
});

test("validateBars keeps the good bars in order and reports what it dropped", () => {
  const bad = { ...ok, time: ok.time + 60, high: 1 };
  const r = validateBars([ok, bad, { ...ok, time: ok.time + 120 }]);
  expect(r.bars.map((b) => b.time)).toEqual([ok.time, ok.time + 120]);
  expect(r.dropped).toEqual([{ time: ok.time + 60, reason: "high is below the open, close or low" }]);
  expect(validateBars([])).toEqual({ bars: [], dropped: [] });
});

const q: Quote = { symbol: "MCX:CRUDEOIL", price: 9400, time: 1_760_000_000_000, source: "upstox" } as Quote;

test("quoteProblem rejects impossible quotes and tolerates a momentarily crossed book", () => {
  expect(quoteProblem(q)).toBeUndefined();
  expect(quoteProblem({ ...q, bid: 9402, ask: 9401 })).toBeUndefined(); // crossed for an instant: allowed
  expect(quoteProblem({ ...q, price: 0 })).toMatch(/price/);
  expect(quoteProblem({ ...q, price: NaN })).toMatch(/price/);
  expect(quoteProblem({ ...q, time: 0 })).toMatch(/time/);
  expect(quoteProblem({ ...q, volume: -5 })).toMatch(/volume/);
  expect(quoteProblem({ ...q, bid: -1 })).toMatch(/bid/);
  expect(quoteProblem({ ...q, high: 9300, low: 9400 })).toMatch(/high is below low/);
});

test("a bar is available only at its close: completedBars drops the forming bar", () => {
  const t0 = 1_760_000_000;
  const bars = [0, 1, 2].map((i) => ({ ...ok, time: t0 + i * 300 }));
  expect(barCloseTime(bars[0], 300)).toBe(t0 + 300);
  expect(completedBars(bars, 300, t0 + 650).map((b) => b.time)).toEqual([t0, t0 + 300]); // bar 2 (open +600) is still forming at +650
  expect(completedBars(bars, 300, t0 + 599).map((b) => b.time)).toEqual([t0]); // bar 1 (open +300) closes at +600: not yet
  expect(completedBars(bars, 300, t0 + 600).map((b) => b.time)).toEqual([t0, t0 + 300]);
  expect(completedBars(bars, 300, t0 + 10_000)).toHaveLength(3);
  expect(completedBars(bars, 300, t0)).toEqual([]);
});

// ---- open interest in candles: Upstox sends it as the seventh field of every futures and options candle
const candles = {
  data: {
    candles: [
      ["2026-10-21T23:29:00+05:30", 9197.0, 9200.0, 9194.0, 9200.0, 79, 13493], // a real futures candle: [time, o, h, l, c, volume, open interest]
      ["2026-10-21T23:28:00+05:30", 9196.0, 9199.0, 9195.0, 9197.0, 40],
    ],
  },
};

test("parseUpstoxCandles keeps the open interest of a candle and leaves it out when the provider sent none", () => {
  const bars = parseUpstoxCandles(candles);
  expect(bars.map((b) => b.time)).toEqual([Date.parse("2026-10-21T23:28:00+05:30") / 1000, Date.parse("2026-10-21T23:29:00+05:30") / 1000]);
  expect(bars[0]).not.toHaveProperty("oi"); // absent, not zero and not null
  expect(bars[1].oi).toBe(13493);
  expect(parseUpstoxCandles({ data: { candles: [["2026-10-21T23:29:00+05:30", 1, 2, 1, 2, 5, null]] } })[0]).not.toHaveProperty("oi");
});

test("normalizeBars carries the open interest through; a bar without it stays without", () => {
  const out = normalizeBars(parseUpstoxCandles(candles), 60, "Asia/Kolkata", 0);
  expect(out[1].oi).toBe(13493);
  expect(out[0]).not.toHaveProperty("oi");
});

test("validateBars drops an impossible open interest from the bar but keeps the bar and its prices", () => {
  const { bars, dropped } = validateBars([{ ...ok, oi: -5 }, { ...ok, time: ok.time + 60, oi: NaN }, { ...ok, time: ok.time + 120, oi: 0 }, { ...ok, time: ok.time + 180, oi: 13493 }, { ...ok, time: ok.time + 240 }]);
  expect(dropped).toEqual([]);
  expect(bars).toHaveLength(5);
  expect(bars[0]).not.toHaveProperty("oi");
  expect(bars[1]).not.toHaveProperty("oi");
  expect(bars[2].oi).toBe(0); // zero is a real reading
  expect(bars[3].oi).toBe(13493);
  expect(bars[4]).not.toHaveProperty("oi");
  expect(bars[0].close).toBe(103);
});
