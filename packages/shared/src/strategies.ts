// Simple, causal strategies for the tester. Each turns bars into a target position after every bar's close:
// +1 long, -1 short, 0 flat. The engine acts on it at the NEXT bar's open, so no signal ever uses a price it could not have had.
import { rsi, sma } from "./indicators";
import type { Bar } from "./index";

export type Position = -1 | 0 | 1;
export type Params = Record<string, number>;

export interface StrategyDef {
  id: string;
  label: string;
  /** user-editable parameters */
  params: { key: string; label: string; min: number; max: number; step: number; value: number }[];
  /** values tried by walk-forward optimisation (kept small on purpose: every extra value is more room to overfit) */
  grid: Record<string, number[]>;
  signals(bars: Bar[], p: Params): Position[];
}

/** Indicator points (time-aligned, warm-up omitted) → one value per bar, undefined where not yet defined. */
const align = (bars: Bar[], pts: { time: number; value: number }[]): (number | undefined)[] => {
  const by = new Map(pts.map((p) => [p.time, p.value]));
  return bars.map((b) => by.get(b.time));
};

const smaCross: StrategyDef = {
  id: "sma-cross",
  label: "SMA crossover",
  params: [
    { key: "fast", label: "Fast SMA", min: 2, max: 100, step: 1, value: 10 },
    { key: "slow", label: "Slow SMA", min: 5, max: 300, step: 1, value: 30 },
  ],
  grid: { fast: [5, 10, 20], slow: [30, 50, 100] },
  signals(bars, p) {
    const f = align(bars, sma(bars, p.fast));
    const s = align(bars, sma(bars, p.slow));
    return bars.map((_, i) => (f[i] === undefined || s[i] === undefined ? 0 : f[i]! > s[i]! ? 1 : f[i]! < s[i]! ? -1 : 0));
  },
};

const rsiReversion: StrategyDef = {
  id: "rsi-reversion",
  label: "RSI mean reversion",
  params: [
    { key: "period", label: "RSI period", min: 2, max: 50, step: 1, value: 14 },
    { key: "low", label: "Buy below", min: 5, max: 45, step: 1, value: 30 },
    { key: "high", label: "Sell above", min: 55, max: 95, step: 1, value: 70 },
  ],
  grid: { period: [7, 14], low: [25, 30], high: [70, 75] },
  signals(bars, p) {
    const r = align(bars, rsi(bars, p.period));
    let pos: Position = 0;
    return bars.map((_, i) => {
      const v = r[i];
      if (v === undefined) return 0;
      if (pos === 0) pos = v < p.low ? 1 : v > p.high ? -1 : 0;
      else if (pos === 1 && v >= 50) pos = 0; // a long ends when RSI is back to neutral
      else if (pos === -1 && v <= 50) pos = 0;
      return pos;
    });
  },
};

const breakout: StrategyDef = {
  id: "breakout",
  label: "Donchian breakout",
  params: [{ key: "length", label: "Lookback bars", min: 5, max: 200, step: 1, value: 20 }],
  grid: { length: [10, 20, 40, 80] },
  signals(bars, p) {
    let pos: Position = 0;
    return bars.map((b, i) => {
      if (i < p.length) return 0;
      const prior = bars.slice(i - p.length, i); // the bars before this one only
      if (b.close > Math.max(...prior.map((x) => x.high))) pos = 1;
      else if (b.close < Math.min(...prior.map((x) => x.low))) pos = -1;
      return pos;
    });
  },
};

export const STRATEGIES: StrategyDef[] = [smaCross, rsiReversion, breakout];
export const strategy = (id: string) => STRATEGIES.find((s) => s.id === id);

/** Every combination of the grid values (small grids only). */
export function gridPoints(grid: Record<string, number[]>): Params[] {
  return Object.entries(grid).reduce<Params[]>((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);
}
