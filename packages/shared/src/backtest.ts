// Backtest engine and validation for the strategy tester. Costs come from the MCX cost engine (costs.ts), so every
// result is net of what Upstox would charge. Pure, seeded and tested: backtest code is easy to get subtly wrong.
import { roundTrip, UPSTOX_MCX_RATES, type CostRates, type Side } from "./costs";
import type { Bar } from "./index";
import { gridPoints, type Params, type Position, type StrategyDef } from "./strategies";

export interface BacktestConfig {
  /** units per lot and lots per trade */
  units: number;
  lots: number;
  /** price points paid against you on every fill (each side) */
  slippage: number;
  rates?: CostRates;
}

export interface Trade {
  side: Side;
  entryIdx: number;
  exitIdx: number;
  entry: number;
  exit: number;
  /** price move × units × lots, after slippage, before charges */
  gross: number;
  costs: number;
  net: number;
}

export interface Metrics {
  net: number;
  gross: number;
  costs: number;
  trades: number;
  winRate: number;
  /** gross profits over gross losses (net of costs per trade); Infinity with no losing trade */
  profitFactor: number;
  avgTrade: number;
  /** largest peak-to-trough fall of the equity curve, rupees (positive) */
  maxDrawdown: number;
}

export interface BacktestResult {
  trades: Trade[];
  /** cumulative net P&L at each bar's close, open trade marked to market with its exit costs */
  equity: number[];
  metrics: Metrics;
}

/**
 * Run target positions through the bars. A change of target after bar i is filled at bar i+1's OPEN (never at the close the signal saw),
 * a flip is a close plus a new entry on the same open, and a position still open at the end is closed at the last close.
 */
export function runBacktest(bars: Bar[], signals: Position[], cfg: BacktestConfig): BacktestResult {
  const rates = cfg.rates ?? UPSTOX_MCX_RATES;
  const trades: Trade[] = [];
  const equity: number[] = new Array(bars.length).fill(0);
  let pos: Position = 0;
  let entryIdx = 0;
  let entry = 0;
  let realised = 0;

  const close = (exitIdx: number, raw: number) => {
    const side: Side = pos === 1 ? "buy" : "sell";
    const exit = pos === 1 ? raw - cfg.slippage : raw + cfg.slippage; // selling a long / buying back a short: worse by the slippage
    const rt = roundTrip("future", side, entry, exit, cfg.units, cfg.lots, rates);
    trades.push({ side, entryIdx, exitIdx, entry, exit, gross: rt.gross, costs: rt.costs.total, net: rt.net });
    realised += rt.net;
    pos = 0;
  };

  for (let i = 0; i < bars.length; i++) {
    if (i > 0 && signals[i - 1] !== pos) {
      const target = signals[i - 1];
      if (pos !== 0) close(i, bars[i].open);
      if (target !== 0) {
        pos = target;
        entryIdx = i;
        entry = target === 1 ? bars[i].open + cfg.slippage : bars[i].open - cfg.slippage;
      }
    }
    let open = 0;
    if (pos !== 0) {
      const mark = pos === 1 ? bars[i].close - cfg.slippage : bars[i].close + cfg.slippage;
      open = roundTrip("future", pos === 1 ? "buy" : "sell", entry, mark, cfg.units, cfg.lots, rates).net;
    }
    equity[i] = realised + open;
  }
  if (pos !== 0) {
    close(bars.length - 1, bars[bars.length - 1].close);
    equity[bars.length - 1] = realised;
  }
  return { trades, equity, metrics: metricsOf(trades, equity) };
}

function metricsOf(trades: Trade[], equity: number[]): Metrics {
  const wins = trades.filter((t) => t.net > 0);
  const profit = wins.reduce((s, t) => s + t.net, 0);
  const loss = trades.filter((t) => t.net < 0).reduce((s, t) => s - t.net, 0);
  let peak = 0;
  let dd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    dd = Math.max(dd, peak - e);
  }
  const net = trades.reduce((s, t) => s + t.net, 0);
  return {
    net,
    gross: trades.reduce((s, t) => s + t.gross, 0),
    costs: trades.reduce((s, t) => s + t.costs, 0),
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: loss === 0 ? (profit > 0 ? Infinity : 0) : profit / loss,
    avgTrade: trades.length ? net / trades.length : 0,
    maxDrawdown: dd,
  };
}

/** Annualised Sharpe of per-bar equity changes against `capital`. One factor (`barsPerYear`) so every figure shares it. */
export function sharpe(equity: number[], capital: number, barsPerYear: number): number | undefined {
  const r = equity.slice(1).map((e, i) => (e - equity[i]) / capital);
  if (r.length < 10) return undefined;
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1));
  return sd === 0 ? undefined : (m / sd) * Math.sqrt(barsPerYear);
}

/** Small seeded generator (mulberry32): the same seed always gives the same validation numbers. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ShiftTest {
  /** share of random timings that did at least as well as the real one, with the real run counted once (smaller = less likely luck) */
  pValue: number;
  runs: number;
  /** net P&L of the middle random timing, and the best 5% cut-off */
  medianNet: number;
  p95Net: number;
}

/**
 * Timing test: keep the strategy's position pattern but slide it around the price series by random offsets. If shifted copies
 * (same exposure, same trade count, wrong timing) often earn as much, the result is not skill. Costs are charged on every run.
 */
export function shiftTest(bars: Bar[], signals: Position[], cfg: BacktestConfig, actualNet: number, runs = 200, seed = 1): ShiftTest {
  const rand = rng(seed);
  const n = signals.length;
  const nets: number[] = [];
  for (let k = 0; k < runs; k++) {
    const off = Math.floor(n * 0.1 + rand() * n * 0.8); // never a near-zero shift
    nets.push(runBacktest(bars, signals.map((_, i) => signals[(i + off) % n]), cfg).metrics.net);
  }
  nets.sort((a, b) => a - b);
  const atLeast = nets.filter((x) => x >= actualNet).length;
  return { pValue: (atLeast + 1) / (runs + 1), runs, medianNet: nets[Math.floor(runs / 2)], p95Net: nets[Math.floor(runs * 0.95)] };
}

export interface BootstrapCI {
  /** 95% interval of the average net per trade, resampling the trades with replacement */
  meanLow: number;
  meanHigh: number;
  /** share of resamples whose average trade is positive */
  probPositive: number;
}

export function bootstrapCI(trades: Trade[], runs = 1000, seed = 1): BootstrapCI | undefined {
  if (trades.length < 5) return undefined; // too few trades for an interval to mean anything
  const rand = rng(seed);
  const nets = trades.map((t) => t.net);
  const means: number[] = [];
  for (let k = 0; k < runs; k++) {
    let s = 0;
    for (let j = 0; j < nets.length; j++) s += nets[Math.floor(rand() * nets.length)];
    means.push(s / nets.length);
  }
  means.sort((a, b) => a - b);
  return { meanLow: means[Math.floor(runs * 0.025)], meanHigh: means[Math.floor(runs * 0.975)], probPositive: means.filter((m) => m > 0).length / runs };
}

export interface WalkFold {
  /** best parameters on the training window, and what they earned there and on the unseen test window */
  params: Params;
  trainNet: number;
  testNet: number;
  testTrades: number;
}

/**
 * Walk-forward: split the bars into `folds + 1` equal chunks; for each fold pick the best grid parameters on everything before the
 * test chunk (expanding window), then run them once on the test chunk. Only the test results are honest. Indicators warm up on
 * earlier bars, so the test chunk can trade from its first bar.
 */
export function walkForward(bars: Bar[], def: StrategyDef, cfg: BacktestConfig, folds = 4): WalkFold[] {
  const chunk = Math.floor(bars.length / (folds + 1));
  if (chunk < 30) return [];
  const grid = gridPoints(def.grid);
  const out: WalkFold[] = [];
  for (let f = 0; f < folds; f++) {
    const trainEnd = chunk * (f + 1);
    const testEnd = f === folds - 1 ? bars.length : trainEnd + chunk;
    const run = (p: Params, from: number, to: number) => {
      const sig = def.signals(bars.slice(0, to), p).slice(from);
      return runBacktest(bars.slice(from, to), sig, cfg).metrics;
    };
    let best = grid[0];
    let bestNet = -Infinity;
    for (const p of grid) {
      const net = run(p, 0, trainEnd).net;
      if (net > bestNet) {
        bestNet = net;
        best = p;
      }
    }
    const test = run(best, trainEnd, testEnd);
    out.push({ params: best, trainNet: bestNet, testNet: test.net, testTrades: test.trades });
  }
  return out;
}

export interface Verdict {
  /** true only when nothing below raises a doubt */
  holdsUp: boolean;
  notes: string[];
}

/** Plain-language doubts about a result. Fixed thresholds: 30 trades, p 0.1, a 95% interval above zero, unseen windows profitable. */
export function judge(m: Metrics, shift?: ShiftTest, ci?: BootstrapCI, walk: WalkFold[] = []): Verdict {
  const notes: string[] = [];
  if (m.trades < 30) notes.push(`Only ${m.trades} trades: too few to trust any statistic.`);
  if (m.net <= 0) notes.push("Loses money after costs.");
  if (shift && shift.pValue > 0.1) notes.push(`Timing is no better than random shifts of the same positions (p = ${shift.pValue.toFixed(2)}): the result may be luck.`);
  if (ci && ci.meanLow <= 0) notes.push("The 95% interval for the average trade includes zero.");
  if (!ci && m.trades >= 1) notes.push("Too few trades for a confidence interval.");
  if (walk.length) {
    const test = walk.reduce((s, f) => s + f.testNet, 0);
    const train = walk.reduce((s, f) => s + f.trainNet, 0);
    if (test <= 0) notes.push("The unseen walk-forward windows lose money in total.");
    else if (train > 0 && test < train / 3) notes.push("Parameters tuned on past bars earned far less on unseen bars: the tuning overfits.");
  } else notes.push("Not enough bars for walk-forward testing.");
  return { holdsUp: notes.length === 0, notes };
}
