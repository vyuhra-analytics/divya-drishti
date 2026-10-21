import { expect, test } from "bun:test";
import { bollinger, ema, macd, rsi, sma, vwap } from "./indicators";
import type { Bar } from "./index";

// Reference values from an independent textbook implementation (Python) on the same deterministic series:
// close_i = round(100 + 10·sin(i/3) + 0.2·i, 4), i = 0..39.
const closes = Array.from({ length: 40 }, (_, i) => Number((100 + 10 * Math.sin(i / 3) + i * 0.2).toFixed(4)));
const bars: Bar[] = closes.map((c, i) => ({ time: i * 60, open: c, high: c + 1, low: c - 1, close: c, volume: 10 + i }));
const last = <T>(a: T[]) => a[a.length - 1];

test("sma", () => {
  const s = sma(bars, 5);
  expect(s).toHaveLength(36);
  expect(last(s).value).toBeCloseTo(105.33932, 8);
  expect(s[0].time).toBe(4 * 60);
});

test("ema seeds with the first close like Pine's ta.ema; warm-up hidden", () => {
  const e = ema(bars, 5);
  expect(e).toHaveLength(36);
  expect(e[0].value).toBeCloseTo(106.828, 8); // value at bar 4
  expect(last(e).value).toBeCloseTo(106.63278100399533, 8);
});

test("bollinger uses population standard deviation", () => {
  const b = bollinger(bars, 5, 2);
  expect(last(b.upper).value).toBeCloseTo(114.52420250150213, 8);
  expect(last(b.middle).value).toBeCloseTo(105.33932, 8);
  expect(last(b.lower).value).toBeCloseTo(96.15443749849787, 8);
});

test("rsi uses Wilder smoothing seeded with the simple average", () => {
  const r = rsi(bars, 5);
  expect(r[0]).toEqual({ time: 5 * 60, value: 100 }); // five straight gains
  expect(last(r).value).toBeCloseTo(84.11873558744222, 8);
});

test("macd line, signal and histogram", () => {
  const m = macd(bars, 3, 6, 4);
  expect(m.macd).toHaveLength(32);
  expect(last(m.macd).value).toBeCloseTo(2.8458891348669795, 8);
  expect(last(m.signal).value).toBeCloseTo(1.56839785633528, 8);
  expect(last(m.histogram).value).toBeCloseTo(1.2774912785316994, 8);
});

test("vwap resets at each exchange-local day and weights by volume", () => {
  const day = 86_400;
  const bar = (t: number, p: number, v: number): Bar => ({ time: t, open: p, high: p, low: p, close: p, volume: v });
  // IST offset 19800 s: 18:30Z is the IST day boundary
  const ist = () => 19_800;
  const series = [bar(day + 3 * 3600, 10, 1), bar(day + 4 * 3600, 20, 3), bar(day + 19 * 3600, 50, 2)];
  const v = vwap(series, ist);
  expect(v.map((p) => p.value)).toEqual([10, 17.5, 50]); // third bar is past 18:30Z → new IST day
  expect(vwap(series).map((p) => p.value)).toEqual([10, 17.5, (10 + 60 + 100) / 6]); // UTC days: no reset
});
