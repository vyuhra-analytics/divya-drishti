import { expect, test } from "bun:test";
import { atr, barsPerYear, drawdown, hurst, realizedVol, regimeOf, volPercentile } from "./stats";
import type { Bar } from "./index";

const bar = (close: number, i = 0, spread = 1): Bar => ({ time: i * 60, open: close, high: close + spread / 2, low: close - spread / 2, close, volume: 1 }) as Bar;
const series = (closes: number[], spread = 1) => closes.map((c, i) => bar(c, i, spread));
/** deterministic pseudo-random in [0,1) */
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

test("realizedVol of a constant 1% daily move scales by sqrt(252)", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i * (i % 2 ? 1.01 : 1 / 1.01) ** 0); // steady growth: zero dispersion
  expect(realizedVol(series(closes), 20, 252)).toBeCloseTo(0, 6);
  const zig = Array.from({ length: 30 }, (_, i) => (i % 2 ? 101 : 100));
  const v = realizedVol(series(zig), 20, 252)!;
  expect(v).toBeGreaterThan(14); // ~1% per bar × sqrt(252) ≈ 15.9%
  expect(v).toBeLessThan(17);
  expect(realizedVol(series([1, 2, 3]), 20, 252)).toBeUndefined();
});

test("barsPerYear knows the chart timeframes", () => {
  expect(barsPerYear("1D")).toBe(252);
  expect(barsPerYear("1h")).toBe(14 * 252);
  expect(barsPerYear("3h")).toBeUndefined();
});

test("atr of unit-range bars with no gaps is 1", () => {
  expect(atr(series(Array(30).fill(100), 1), 14)).toBeCloseTo(1, 9);
  expect(atr(series([1, 2]), 14)).toBeUndefined();
});

test("drawdown finds the worst fall and the current distance from the peak", () => {
  const d = drawdown(series([100, 120, 90, 110]))!;
  expect(d.max).toBeCloseTo(25, 9);
  expect(d.current).toBeCloseTo((10 / 120) * 100, 9);
  expect(drawdown(series([5]))).toBeUndefined();
});

test("hurst separates trends, random walks and mean reversion", () => {
  const r = rng(7);
  const walk = (step: (prev: number) => number) => {
    const out = [100];
    for (let i = 0; i < 511; i++) out.push(out[i] * Math.exp(step(i)));
    return series(out);
  };
  let drift = 0;
  const trend = walk(() => 0.001 + (r() - 0.5) * 0.002 + (drift = drift * 0.9 + (r() - 0.5) * 0.004)); // persistent returns
  let prev = 0;
  const revert = walk(() => (prev = -0.8 * prev + (r() - 0.5) * 0.004)); // each return opposes the last
  const noise = walk(() => (r() - 0.5) * 0.01);
  expect(hurst(trend)!).toBeGreaterThan(hurst(noise)!);
  expect(hurst(revert)!).toBeLessThan(hurst(noise)!);
  expect(hurst(series([1, 2, 3]))).toBeUndefined();
});

test("regimeOf thresholds", () => {
  expect(regimeOf(0.7)).toBe("trending");
  expect(regimeOf(0.5)).toBe("random");
  expect(regimeOf(0.3)).toBe("mean-reverting");
  expect(regimeOf(undefined)).toBeUndefined();
});

test("volPercentile ranks calm after wild as low, wild after calm as high", () => {
  const r = rng(3);
  const calm = Array.from({ length: 80 }, () => 100 + (r() - 0.5) * 0.2);
  const wild = Array.from({ length: 80 }, () => 100 + (r() - 0.5) * 6);
  expect(volPercentile(series([...wild, ...calm]), 20)!).toBeLessThan(20);
  expect(volPercentile(series([...calm, ...wild.slice(0, 20)]), 20)!).toBeGreaterThan(95); // a fresh spike tops its own history
  expect(volPercentile(series(calm.slice(0, 30)), 20)).toBeUndefined();
});
