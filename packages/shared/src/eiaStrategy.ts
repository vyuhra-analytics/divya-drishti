// The EIA report-day strategy as a replay over one-minute candles: a surprise at or beyond the threshold picks a side (a draw below the forecast = long, a
// build above = short), the trade enters at the open of the first traded minute after the release, and is split in two equal legs with a stop at 1R and
// targets at +1R and +2R. R is a percentage of the entry price, 0.5% by the owner's definition. Conservative on purpose: within one minute the
// stop is assumed hit before a target, a gap through the stop fills at the open, slippage is charged on every market fill, the full Upstox costs per leg.
// Causal: nothing after the entry minute is used to decide the entry. Pure and tested; the runner that reads the database is scripts/eia-replay.ts.
import { roundTrip, type Kind } from "./costs";
import type { Bar } from "./index";

export type ReportSide = "long" | "short";

/** The side the report-day rule allows: undefined under the threshold. `surprise` = actual change minus forecast. */
export function reportSignal(surprise: number | undefined, threshold: number): ReportSide | undefined {
  if (surprise === undefined || !Number.isFinite(surprise) || Math.abs(surprise) < threshold) return undefined;
  return surprise < 0 ? "long" : "short";
}

export interface ReportTradeConfig {
  /** R as a percentage of the entry price (0.5 by the owner) */
  rPct: number;
  /** whole minutes after the release before the entry (the entry is the open of the first traded minute at or after this) */
  delayMin: number;
  /** the trade is closed at the close of the last minute inside this many minutes of entry */
  holdMin: number;
  /** price points paid against you on every market fill */
  slip: number;
  units: number;
  /** lots in each of the two legs */
  lotsPerLeg: number;
  kind?: Kind;
}

export interface ReportLeg {
  targetR: 1 | 2;
  exit: number;
  exitAt: number;
  reason: "target" | "stop" | "time";
  /** the move in the trade's favour as a multiple of R, before costs */
  r: number;
}

export interface ReportTrade {
  side: ReportSide;
  entry: number;
  entryAt: number;
  rPoints: number;
  legs: ReportLeg[];
  gross: number;
  costs: number;
  net: number;
  /** net as a multiple of the rupees risked (R x units x all lots) */
  netR: number;
}

export type ReportSkip =
  | "no signal"
  | "no traded minute before the release"
  | "no traded minute after the release"
  | "no sweep of the pre-release range"
  | "the spike went with the surprise: no manipulation to trade"
  | "no displacement after the sweep"
  | "no retrace into the gap";

/**
 * Replay one release. `bars` are the candles of ONE contract, any order. A minute counts as traded when its volume is above zero (Upstox forward-fills
 * minutes with no trade, which would otherwise look like a calm market). Returns why nothing was traded instead of guessing.
 */
export function replayReportTrade(bars: readonly Bar[], releaseAtSec: number, side: ReportSide | undefined, cfg: ReportTradeConfig): ReportTrade | ReportSkip {
  if (!side) return "no signal";
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  if (!sorted.some((b) => b.volume > 0 && b.time < releaseAtSec && b.time >= releaseAtSec - 3600)) return "no traded minute before the release";
  const from = releaseAtSec + cfg.delayMin * 60;
  const iEntry = sorted.findIndex((b) => b.time >= from && b.volume > 0);
  if (iEntry < 0 || sorted[iEntry].time > from + 5 * 60) return "no traded minute after the release";

  return simulateTrade(sorted, iEntry, sorted[iEntry].open, side, cfg);
}

/**
 * Run a trade that is filled in bar `iEntry` at `rawEntry` (a market entry at the open, or a limit level touched in that bar): the two legs, the stop at
 * 1R, the targets at +1R and +2R and the time exit, with slippage on the entry and on every market fill. The same exits whatever the entry, so two
 * entry rules can be compared on the exits alone.
 */
function simulateTrade(sorted: readonly Bar[], iEntry: number, rawEntry: number, side: ReportSide, cfg: ReportTradeConfig): ReportTrade {
  const dir = side === "long" ? 1 : -1;
  const entry = rawEntry + dir * cfg.slip;
  const R = (entry * cfg.rPct) / 100;
  const stop = entry - dir * R;
  const targets = { 1: entry + dir * R, 2: entry + dir * 2 * R } as const;
  const window = sorted.slice(iEntry).filter((b) => b.time < sorted[iEntry].time + cfg.holdMin * 60);
  const open: (1 | 2)[] = [1, 2];
  const legs: ReportLeg[] = [];
  const close = (targetR: 1 | 2, exit: number, exitAt: number, reason: ReportLeg["reason"]) => legs.push({ targetR, exit, exitAt, reason, r: (dir * (exit - entry)) / R });

  for (const b of window) {
    const stopHit = dir === 1 ? b.low <= stop : b.high >= stop;
    if (stopHit) {
      // a gap through the stop fills at the open; otherwise at the stop; the market fill pays the slippage
      const gap = dir === 1 ? Math.min(stop, b.open) : Math.max(stop, b.open);
      for (const t of open.splice(0)) close(t, gap - dir * cfg.slip, b.time, "stop");
      break;
    }
    for (const t of [...open]) {
      if (dir === 1 ? b.high >= targets[t] : b.low <= targets[t]) {
        close(t, targets[t], b.time, "target");
        open.splice(open.indexOf(t), 1);
      }
    }
    if (!open.length) break;
  }
  const last = window[window.length - 1];
  for (const t of open) close(t, last.close - dir * cfg.slip, last.time, "time");

  const kind = cfg.kind ?? "future";
  let gross = 0;
  let costs = 0;
  for (const l of legs) {
    const rt = roundTrip(kind, side === "long" ? "buy" : "sell", entry, l.exit, cfg.units, cfg.lotsPerLeg);
    gross += rt.gross;
    costs += rt.costs.total;
  }
  const risk = R * cfg.units * cfg.lotsPerLeg * 2;
  return { side, entry, entryAt: sorted[iEntry].time, rPoints: R, legs: legs.sort((a, b) => a.targetR - b.targetR), gross, costs, net: gross - costs, netR: (gross - costs) / risk };
}

export type AmdDirection = "sweep" | "surprise";

export interface AmdConfig extends ReportTradeConfig {
  /** which way to trade: against the sweep (the article's reversal after the manipulation) or with the surprise (entered on the retrace after the spike) */
  direction: AmdDirection;
  /** minutes before the release whose high and low are the accumulation range (default 30) */
  preMin?: number;
  /** minutes after the release in which the range must be swept (default 15) */
  sweepWithinMin?: number;
  /** minutes after the sweep to find the displacement, and after the gap to find the retrace (default 30 each) */
  waitMin?: number;
  /** a displacement bar's body must be this many times the average body of the accumulation bars (default 1.5) */
  bodyMult?: number;
}

/**
 * The "wait for the manipulation, enter on the retrace" entry of the AMD model (accumulation, manipulation, distribution) around a scheduled release,
 * as one mechanical rule on one-minute bars, then the SAME exits as `replayReportTrade` (stop 1R, targets +1R and +2R), so only the entry differs.
 *  - accumulation: the high and low of the `preMin` minutes before the release;
 *  - manipulation: the first bar within `sweepWithinMin` minutes after the release that takes out one side of that range (the spike);
 *  - displacement: a later bar in the opposite direction of the spike (for `direction: "sweep"`) or in the surprise's direction, whose body is large (a multiple of the average body of the accumulation bars) and
 *    that closes beyond the sweep bar, leaving a fair value gap (three bars where the first bar's low is above the third bar's high, or the mirror);
 *  - entry: a limit at the near edge of the gap, filled by the first bar that retraces into it (at the open when the bar opens already through it); if
 *    there is no retrace in `waitMin` minutes, no trade (never chase).
 * Every decision uses bars that have closed; the gap needs the bar after the displacement, so the entry search starts one bar later.
 */
export function replayAmdTrade(bars: readonly Bar[], releaseAtSec: number, surpriseSide: ReportSide | undefined, cfg: AmdConfig): ReportTrade | ReportSkip {
  if (!surpriseSide) return "no signal";
  const b = [...bars].sort((x, y) => x.time - y.time);
  if (!b.some((x) => x.volume > 0 && x.time < releaseAtSec && x.time >= releaseAtSec - 3600)) return "no traded minute before the release";
  const preMin = cfg.preMin ?? 30;
  const sweepWithin = cfg.sweepWithinMin ?? 15;
  const wait = cfg.waitMin ?? 30;
  const mult = cfg.bodyMult ?? 1.5;

  const pre = b.filter((x) => x.time >= releaseAtSec - preMin * 60 && x.time < releaseAtSec && x.volume > 0);
  if (!pre.length) return "no traded minute before the release";
  const H = Math.max(...pre.map((x) => x.high));
  const L = Math.min(...pre.map((x) => x.low));

  // manipulation: the first bar that takes out the range
  const iSweep = b.findIndex((x) => x.time >= releaseAtSec && x.time < releaseAtSec + sweepWithin * 60 && x.volume > 0 && (x.high > H || x.low < L));
  if (iSweep < 0) return "no sweep of the pre-release range";
  const sweptHigh = b[iSweep].high > H;
  if (b[iSweep].high > H && b[iSweep].low < L) return "no sweep of the pre-release range"; // both sides in one bar: no direction

  const side: ReportSide = cfg.direction === "sweep" ? (sweptHigh ? "short" : "long") : surpriseSide;
  if (cfg.direction === "surprise" && (side === "long") === sweptHigh) return "the spike went with the surprise: no manipulation to trade";
  const dir = side === "long" ? 1 : -1;

  // displacement leaving a gap
  const body = (x: Bar) => Math.abs(x.close - x.open);
  let iDisp = -1;
  // "strong" is measured against the accumulation bars (the quiet minutes before the release), not the bars just before the displacement, which include the spike
  const avg = pre.reduce((a, x) => a + body(x), 0) / pre.length;
  for (let j = iSweep + 1; j < b.length - 1 && b[j].time <= b[iSweep].time + wait * 60; j++) {
    const strong = body(b[j]) >= mult * avg && body(b[j]) > 0;
    const inDir = dir === 1 ? b[j].close > b[j].open && b[j].close > b[iSweep].high : b[j].close < b[j].open && b[j].close < b[iSweep].low;
    const gapOk = dir === 1 ? b[j - 1].high < b[j + 1].low : b[j - 1].low > b[j + 1].high;
    if (strong && inDir && gapOk) {
      iDisp = j;
      break;
    }
  }
  if (iDisp < 0) return "no displacement after the sweep";

  // the gap: for a short, from the third bar's high up to the first bar's low (price retraces up into it); the mirror for a long
  const near = dir === 1 ? b[iDisp + 1].low : b[iDisp + 1].high;
  const until = b[iDisp + 1].time + wait * 60;
  for (let k = iDisp + 2; k < b.length && b[k].time <= until; k++) {
    const touched = dir === 1 ? b[k].low <= near : b[k].high >= near;
    // a limit fills at its level, or at the open when the bar opens already through it (a gap): never better than the market gave
    if (touched && b[k].volume > 0) return simulateTrade(b, k, dir === 1 ? Math.min(near, b[k].open) : Math.max(near, b[k].open), side, cfg);
  }
  return "no retrace into the gap";
}

export interface ReplaySummary {
  trades: number;
  winners: number;
  /** trades with a net gain after every cost */
  winRate: number | undefined;
  netTotal: number;
  grossTotal: number;
  costsTotal: number;
  avgNetR: number | undefined;
  profitFactor: number | undefined;
  /** sum of net by side */
  bySide: Record<ReportSide, { trades: number; net: number }>;
  skipped: Record<string, number>;
}

export function summarizeReplay(results: readonly (ReportTrade | ReportSkip)[]): ReplaySummary {
  const trades = results.filter((r): r is ReportTrade => typeof r !== "string");
  const skipped: Record<string, number> = {};
  for (const r of results) if (typeof r === "string") skipped[r] = (skipped[r] ?? 0) + 1;
  const wins = trades.filter((t) => t.net > 0);
  const gain = wins.reduce((a, t) => a + t.net, 0);
  const loss = trades.filter((t) => t.net < 0).reduce((a, t) => a + -t.net, 0);
  const side = (s: ReportSide) => ({ trades: trades.filter((t) => t.side === s).length, net: trades.filter((t) => t.side === s).reduce((a, t) => a + t.net, 0) });
  return {
    trades: trades.length,
    winners: wins.length,
    winRate: trades.length ? wins.length / trades.length : undefined,
    netTotal: trades.reduce((a, t) => a + t.net, 0),
    grossTotal: trades.reduce((a, t) => a + t.gross, 0),
    costsTotal: trades.reduce((a, t) => a + t.costs, 0),
    avgNetR: trades.length ? trades.reduce((a, t) => a + t.netR, 0) / trades.length : undefined,
    profitFactor: loss > 0 ? gain / loss : undefined,
    bySide: { long: side("long"), short: side("short") },
    skipped,
  };
}

/** One release in a replay: the surprise, the contract used and what happened. */
export interface ReplayRow {
  /** the release, epoch ms */
  at: number;
  surprise?: number;
  contract?: string;
  result: ReportTrade | ReportSkip;
}

/** how the trade is entered: at the open right after the release, or the AMD entry (wait for the sweep and enter on the retrace into the gap) against the sweep or with the surprise */
export const REPLAY_ENTRIES = ["release", "amd-sweep", "amd-surprise"] as const;
export type ReplayEntry = (typeof REPLAY_ENTRIES)[number];

export interface ReplayParams {
  report: "WPSR" | "WNGSR";
  entry: ReplayEntry;
  underlying: "CRUDEOIL" | "CRUDEOILM" | "NATURALGAS" | "NATGASMINI";
  rPct: number;
  delayMin: number;
  holdMin: number;
  slip: number;
  threshold: number;
  /** YYYY-MM-DD: releases from this day on */
  since: string;
}

export interface ReplayReport {
  params: ReplayParams;
  units: number;
  rows: ReplayRow[];
  summary: ReplaySummary;
  /** the same replay at other values of R, for reading how much the answer depends on it (never for picking the best) */
  sensitivity?: { rPct: number; summary: ReplaySummary }[];
}

export const REPLAY_UNDERLYINGS = ["CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI"] as const;
export const SENSITIVITY_R = [0.15, 0.3, 0.5, 0.75, 1] as const;
