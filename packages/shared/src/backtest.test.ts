import { expect, test } from "bun:test";
import { bootstrapCI, rng, runBacktest, sharpe, shiftTest, walkForward, type BacktestConfig, type Trade } from "./backtest";
import { roundTrip } from "./costs";
import type { Bar } from "./index";
import { STRATEGIES, gridPoints, strategy, type Position } from "./strategies";

const bar = (i: number, open: number, close = open, spread = 1): Bar => ({ time: 1000 + i * 60, open, high: Math.max(open, close) + spread, low: Math.min(open, close) - spread, close, volume: 1 }) as Bar;
const cfg: BacktestConfig = { units: 100, lots: 1, slippage: 0 };

test("a signal after bar i is filled at bar i+1's open, never at the close it saw", () => {
  const bars = [bar(0, 100, 100), bar(1, 110, 110), bar(2, 120, 130), bar(3, 140, 140)];
  const sig: Position[] = [1, 1, 0, 0]; // long after bar 0, flat after bar 2
  const r = runBacktest(bars, sig, cfg);
  expect(r.trades).toHaveLength(1);
  expect(r.trades[0]).toMatchObject({ side: "buy", entryIdx: 1, exitIdx: 3, entry: 110, exit: 140 }); // in at bar 1's open 110, out at bar 3's open 140
  expect(r.trades[0].gross).toBe(30 * 100);
});

test("costs and slippage come off every trade", () => {
  const bars = [bar(0, 100), bar(1, 100), bar(2, 100), bar(3, 100)];
  const r = runBacktest(bars, [1, 1, 0, 0], { ...cfg, slippage: 0.5 });
  const t = r.trades[0];
  expect(t.entry).toBe(100.5); // bought half a point worse
  expect(t.exit).toBe(99.5); // sold half a point worse
  expect(t.gross).toBeCloseTo(-1 * 100, 9);
  expect(t.costs).toBeCloseTo(roundTrip("future", "buy", 100.5, 99.5, 100, 1).costs.total, 9);
  expect(t.net).toBeCloseTo(t.gross - t.costs, 9);
  expect(r.metrics.net).toBeCloseTo(t.net, 9);
});

test("a flip closes and reopens on the same open; an open trade is closed at the last close", () => {
  const bars = [bar(0, 100), bar(1, 100), bar(2, 110), bar(3, 105, 90)];
  const r = runBacktest(bars, [1, -1, -1, -1], cfg);
  expect(r.trades.map((t) => [t.side, t.entryIdx, t.exitIdx, t.entry, t.exit])).toEqual([
    ["buy", 1, 2, 100, 110], // long from bar 1's open, flipped at bar 2's open
    ["sell", 2, 3, 110, 90], // short from 110, still open at the end: closed at the last close
  ]);
  expect(r.equity[r.equity.length - 1]).toBeCloseTo(r.metrics.net, 9);
});

test("equity marks the open trade to market with its exit costs", () => {
  const bars = [bar(0, 100), bar(1, 100), bar(2, 104, 106), bar(3, 106)];
  const r = runBacktest(bars, [1, 1, 1, 1], cfg);
  expect(r.equity[0]).toBe(0);
  expect(r.equity[2]).toBeCloseTo(roundTrip("future", "buy", 100, 106, 100, 1).net, 9);
});

test("metrics: win rate, profit factor and drawdown", () => {
  // two trades: +20 then -10 (price points), flat in between
  const bars = [bar(0, 100), bar(1, 100), bar(2, 120), bar(3, 120), bar(4, 120), bar(5, 110)];
  const r = runBacktest(bars, [1, 0, 0, 1, 0, 0] as Position[], cfg);
  expect(r.metrics.trades).toBe(2);
  expect(r.metrics.winRate).toBe(0.5);
  expect(r.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
  expect(r.metrics.profitFactor).toBeGreaterThan(0);
  expect(r.metrics.net).toBeCloseTo(r.trades[0].net + r.trades[1].net, 9);
  expect(runBacktest(bars, [0, 0, 0, 0, 0, 0], cfg).metrics).toMatchObject({ trades: 0, net: 0, winRate: 0 });
});

test("strategies are causal: appending bars never changes earlier signals", () => {
  const r = rng(11);
  let p = 9000;
  const bars: Bar[] = Array.from({ length: 300 }, (_, i) => {
    const o = p;
    p += (r() - 0.5) * 40;
    return bar(i, o, p, 8);
  });
  for (const s of STRATEGIES) {
    const params = Object.fromEntries(s.params.map((x) => [x.key, x.value]));
    const full = s.signals(bars, params);
    const prefix = s.signals(bars.slice(0, 200), params);
    expect(prefix).toEqual(full.slice(0, 200));
  }
  expect(strategy("sma-cross")?.label).toBe("SMA crossover");
  expect(gridPoints({ a: [1, 2], b: [3] })).toEqual([{ a: 1, b: 3 }, { a: 2, b: 3 }]);
});

test("rng is deterministic per seed", () => {
  const a = rng(5);
  const b = rng(5);
  expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  expect(rng(5)()).not.toBe(rng(6)());
});

/** a market that trends up for 40 bars, down for 40, and so on */
const regimes = (n: number): Bar[] => {
  let p = 9000;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p += Math.floor(i / 40) % 2 === 0 ? 15 : -15;
    return bar(i, o, p, 3);
  });
};

test("shiftTest: a strategy that really follows the trend beats most random timings; its p-value is reproducible", () => {
  const bars = regimes(400);
  // the position that is right in every regime (uses the regime, so only the test fixture can know it)
  const perfect: Position[] = bars.map((_, i) => (Math.floor((i + 1) / 40) % 2 === 0 ? 1 : -1));
  const real = runBacktest(bars, perfect, cfg).metrics.net;
  expect(real).toBeGreaterThan(0);
  const t = shiftTest(bars, perfect, cfg, real, 100, 7);
  expect(t.pValue).toBeLessThan(0.1);
  expect(t.p95Net).toBeLessThan(real);
  expect(shiftTest(bars, perfect, cfg, real, 100, 7)).toEqual(t);
  // a strategy that earns nothing special has no edge over its own shifted copies
  const flat = shiftTest(bars, perfect, cfg, -Infinity, 50, 7);
  expect(flat.pValue).toBeCloseTo(1, 9);
});

const trade = (net: number): Trade => ({ side: "buy", entryIdx: 0, exitIdx: 1, entry: 1, exit: 1, gross: net, costs: 0, net });

test("bootstrapCI brackets the average trade and refuses a handful of trades", () => {
  const wins = Array.from({ length: 30 }, () => trade(100));
  const ci = bootstrapCI(wins, 500, 3)!;
  expect(ci.meanLow).toBe(100);
  expect(ci.meanHigh).toBe(100);
  expect(ci.probPositive).toBe(1);
  const mixed = Array.from({ length: 40 }, (_, i) => trade(i % 2 ? 150 : -140));
  const m = bootstrapCI(mixed, 500, 3)!;
  expect(m.meanLow).toBeLessThan(5);
  expect(m.meanHigh).toBeGreaterThan(5);
  expect(m.probPositive).toBeGreaterThan(0);
  expect(m.probPositive).toBeLessThan(1);
  expect(bootstrapCI(wins.slice(0, 4))).toBeUndefined();
});

test("walkForward picks parameters on earlier bars and reports only the unseen chunk", () => {
  const bars = regimes(600);
  const sma = strategy("sma-cross")!;
  const folds = walkForward(bars, sma, cfg, 4);
  expect(folds).toHaveLength(4);
  for (const f of folds) {
    expect(Object.keys(f.params).sort()).toEqual(["fast", "slow"]);
    expect(Number.isFinite(f.trainNet)).toBe(true);
    expect(Number.isFinite(f.testNet)).toBe(true);
  }
  expect(walkForward(bars, sma, cfg, 4)).toEqual(folds);
  expect(walkForward(bars.slice(0, 80), sma, cfg, 4)).toEqual([]); // too short to split
});

test("sharpe uses one annualisation factor and needs enough bars", () => {
  const eq = Array.from({ length: 50 }, (_, i) => i * 10 + (i % 2 ? 1 : 0));
  const s = sharpe(eq, 100_000, 252)!;
  expect(s).toBeGreaterThan(0);
  expect(sharpe(eq, 100_000, 252 * 4)!).toBeCloseTo(s * 2, 9);
  expect(sharpe([0, 1, 2], 100, 252)).toBeUndefined();
});

import { judge, type Metrics } from "./backtest";

test("judge lists every doubt, and passes only a clean result", () => {
  const m: Metrics = { net: 1000, gross: 1500, costs: 500, trades: 50, winRate: 0.5, profitFactor: 1.5, avgTrade: 20, maxDrawdown: 300 };
  const shift = { pValue: 0.02, runs: 200, medianNet: 0, p95Net: 500 };
  const ci = { meanLow: 5, meanHigh: 35, probPositive: 0.99 };
  const walk = [{ params: {}, trainNet: 900, testNet: 700, testTrades: 12 }];
  expect(judge(m, shift, ci, walk)).toEqual({ holdsUp: true, notes: [] });

  const bad = judge({ ...m, trades: 8, net: -50 }, { ...shift, pValue: 0.4 }, { ...ci, meanLow: -3 }, [{ params: {}, trainNet: 900, testNet: -100, testTrades: 3 }]);
  expect(bad.holdsUp).toBe(false);
  expect(bad.notes.join(" ")).toMatch(/Only 8 trades/);
  expect(bad.notes.join(" ")).toMatch(/Loses money after costs/);
  expect(bad.notes.join(" ")).toMatch(/p = 0.40/);
  expect(bad.notes.join(" ")).toMatch(/includes zero/);
  expect(bad.notes.join(" ")).toMatch(/lose money in total/);
  expect(judge(m, shift, ci, [{ params: {}, trainNet: 900, testNet: 100, testTrades: 5 }]).notes.join(" ")).toMatch(/overfits/);
});
