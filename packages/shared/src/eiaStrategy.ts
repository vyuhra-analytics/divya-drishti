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

export type ReportSkip = "no signal" | "no traded minute before the release" | "no traded minute after the release";

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

  const dir = side === "long" ? 1 : -1;
  const entry = sorted[iEntry].open + dir * cfg.slip;
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

export interface ReplayParams {
  report: "WPSR" | "WNGSR";
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
