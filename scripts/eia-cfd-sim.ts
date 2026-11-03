// Day-by-day paper simulator for the EIA crude report day on the Dukascopy CFD. One side per day (never both), trading only inside the window from
// 60 minutes before the release to 90 minutes after it: the trade enters after the print on the surprise's side and every open leg is closed at the
// window's end. Results in R before costs, in a ledger file with one row per report day.
//   bun run --env-file=.env scripts/eia-cfd-sim.ts [--threshold=3] [--delay=1] [--rpct=0.5] [--slip=0.03] [--out=DIR]
//   Breakout entry: add --breakout=5 (candle minutes) [--side=surprise|any] [--cutoff=90]: enter only after a candle closes beyond the high/low of the hour
//   before the print (surprise = only on the surprise's side, any = the first close beyond either side, the surprise is then ignored).
// Safety: external_bars is only READ (the connection is read-only and the run refuses to start if it is not), and no day from 2022 onward is ever loaded.
// Progress goes to <out>/sim-status.json and <out>/sim-progress.log after every 10 days.
import { SQL } from "bun";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { replayReportTrade, reportSignal, type ReportSide, type ReportTrade } from "../packages/shared/src/eiaStrategy";
import type { Bar } from "../packages/shared/src/index";
import { randomSideP, summarizeR, type Day } from "./eia-cfd-stats";

/** The holdout starts here. No code path in this file loads a release at or after it. */
export const HOLDOUT_FROM = Date.parse("2022-01-01T00:00:00Z");
export const BEFORE_MIN = 60;
export const AFTER_MIN = 90;

export interface SimConfig {
  rPct: number;
  delayMin: number;
  slip: number;
  threshold: number;
  /** enter only when a candle CLOSES beyond the high or low of the 60 minutes before the release (entry = the open after that candle) */
  breakout?: { candleMin: number; cutoffMin: number; side: "surprise" | "any" };
}

export interface ReportDay {
  /** the release, epoch ms */
  at: number;
  forecast?: number;
  actual?: number;
  /** one-minute bars around the release, any order */
  bars: readonly Bar[];
}

export interface LedgerRow {
  date: string;
  releaseUtc: string;
  forecast?: number;
  actual?: number;
  surprise?: number;
  /** the one side traded; absent when nothing was traded */
  side?: ReportSide;
  status: "traded" | string;
  /** high-low of the hour before the print as a % of the last pre-print close */
  preRangePct?: number;
  /** breakout mode: the high and low of the hour before the print, and when the candle that closed beyond one of them ended */
  preHigh?: number;
  preLow?: number;
  breakAt?: string;
  entryAt?: string;
  entry?: number;
  /** the entry's gap from the last pre-print close, as a % in the trade's favour (negative = chased the move) */
  entryGapPct?: number;
  rPoints?: number;
  leg1?: string;
  leg2?: string;
  /** average of the two legs, R before costs */
  r?: number;
  /** the same day traded on the other side: for the random-side test only, never a second trade */
  rOtherSide?: number;
}

const rOf = (t: ReportTrade) => (t.legs[0].r + t.legs[1].r) / 2;
const legText = (l: ReportTrade["legs"][number]) => `${l.reason} ${l.r.toFixed(2)}R at ${new Date(l.exitAt * 1000).toISOString().slice(11, 16)}`;

/** One report day: at most one side, only bars inside [release - 60 min, release + 90 min), closed at the window's end. */
export function simulateDay(d: ReportDay, cfg: SimConfig): LedgerRow {
  if (d.at >= HOLDOUT_FROM) throw new Error("holdout day refused: the simulator only runs before 2022-01-01");
  const atSec = d.at / 1000;
  const iso = new Date(d.at).toISOString();
  const base: LedgerRow = { date: iso.slice(0, 10), releaseUtc: iso.slice(11, 16), forecast: d.forecast, actual: d.actual, status: "traded" };
  if (d.forecast === undefined || d.actual === undefined) return { ...base, status: "no forecast or actual" };
  const surprise = d.actual - d.forecast;
  const win = d.bars.filter((b) => b.time >= atSec - BEFORE_MIN * 60 && b.time < atSec + AFTER_MIN * 60);
  const pre = win.filter((b) => b.time < atSec && b.volume > 0).sort((a, b) => a.time - b.time);
  const preClose = pre.at(-1)?.close;
  const preRangePct = preClose ? ((Math.max(...pre.map((b) => b.high)) - Math.min(...pre.map((b) => b.low))) / preClose) * 100 : undefined;
  const row: LedgerRow = { ...base, surprise, preRangePct };
  let side: ReportSide | undefined = reportSignal(surprise, cfg.threshold);
  let delayMin = cfg.delayMin;
  let brk: { hi: number; lo: number; at: number } | undefined;
  const bo = cfg.breakout;
  if (bo) {
    if (bo.side === "surprise" && !side) return { ...row, status: "no signal" };
    if (!pre.length) return { ...row, status: "no pre-release bars" };
    const hi = Math.max(...pre.map((b) => b.high));
    const lo = Math.min(...pre.map((b) => b.low));
    const step = bo.candleMin * 60;
    const closes = new Map<number, number>(); // candle number after the print -> close of its last minute
    for (const b of [...win].sort((a, c) => a.time - c.time)) if (b.time >= atSec) closes.set(Math.floor((b.time - atSec) / step), b.close);
    for (const k of [...closes.keys()].sort((a, c) => a - c)) {
      const end = (k + 1) * step;
      if (end > bo.cutoffMin * 60) break;
      const c = closes.get(k)!;
      const dir: ReportSide | undefined = c > hi ? "long" : c < lo ? "short" : undefined;
      if (!dir || (bo.side === "surprise" && dir !== side)) continue; // a break against the surprise is not an entry; keep watching
      side = dir;
      delayMin = end / 60;
      brk = { hi, lo, at: atSec + end };
      break;
    }
    if (!brk) return { ...row, status: "no breakout", preHigh: hi, preLow: lo };
    Object.assign(row, { preHigh: hi, preLow: lo, breakAt: new Date(brk.at * 1000).toISOString().slice(11, 16) });
  }
  if (!side) return { ...row, status: "no signal" };

  // holdMin 90 is longer than anything left in the truncated window, so the window's end closes the trade
  const tc = { rPct: cfg.rPct, delayMin, holdMin: AFTER_MIN, slip: cfg.slip, units: 1, lotsPerLeg: 1 };
  const t = replayReportTrade(win, atSec, side, tc);
  if (typeof t === "string") return { ...row, status: t };
  const other = replayReportTrade(win, atSec, side === "long" ? "short" : "long", tc);
  const dir = side === "long" ? 1 : -1;
  return {
    ...row,
    side,
    entryAt: new Date(t.entryAt * 1000).toISOString().slice(11, 16),
    entry: t.entry,
    entryGapPct: preClose ? (dir * (t.entry - preClose) / preClose) * 100 : undefined,
    rPoints: t.rPoints,
    leg1: legText(t.legs[0]),
    leg2: legText(t.legs[1]),
    r: rOf(t),
    rOtherSide: typeof other === "string" ? undefined : rOf(other),
  };
}

const COLS: (keyof LedgerRow)[] = ["date", "releaseUtc", "forecast", "actual", "surprise", "side", "status", "preRangePct", "preHigh", "preLow", "breakAt", "entryAt", "entry", "entryGapPct", "rPoints", "leg1", "leg2", "r", "rOtherSide"];
const cell = (v: unknown) => (v === undefined ? "" : typeof v === "number" ? String(Math.round(v * 1e4) / 1e4) : `"${String(v).replace(/"/g, '""')}"`);
export const ledgerCsv = (rows: readonly LedgerRow[]) => [COLS.join(","), ...rows.map((r) => COLS.map((c) => cell(r[c])).join(","))].join("\n");

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const out = arg("out") ?? "I:/divya-drishti-data/dukascopy/backtest";
  const symbol = arg("symbol") ?? "lightcmdusd";
  const cfg: SimConfig = { rPct: Number(arg("rpct") ?? 0.5), delayMin: Number(arg("delay") ?? 1), slip: Number(arg("slip") ?? 0.03), threshold: Number(arg("threshold") ?? 3) };
  const bk = Number(arg("breakout") ?? 0);
  if (bk > 0) cfg.breakout = { candleMin: bk, cutoffMin: Number(arg("cutoff") ?? AFTER_MIN), side: arg("side") === "any" ? "any" : "surprise" };
  mkdirSync(out, { recursive: true });
  const started = Date.now();
  const status = (state: string, done: number, total: number, note = "") => {
    const el = (Date.now() - started) / 1000;
    const s = { state, done, total, pct: total ? Math.round((done / total) * 100) : 0, note, elapsedSec: Math.round(el), etaSec: done && total > done ? Math.round((el / done) * (total - done)) : 0, updatedAt: new Date().toISOString() };
    writeFileSync(`${out}/sim-status.json`, JSON.stringify(s, null, 2));
    appendFileSync(`${out}/sim-progress.log`, `${s.updatedAt} ${state} ${done}/${total} ${note}\n`);
    console.log(`${state} ${done}/${total} ${note}`);
  };

  // read-only session: a write to external_bars (or anything) fails at the database
  const sql = new SQL(process.env.DATABASE_URL!, { max: 1, connection: { default_transaction_read_only: "on" } });
  try {
    const ro = (await sql`SHOW default_transaction_read_only`) as { default_transaction_read_only: string }[];
    if (ro[0]?.default_transaction_read_only !== "on") throw new Error("the connection is not read-only; refusing to run");
    status("running", 0, 1, "reading releases");
    const fc = (await sql`SELECT release_at, forecast, actual FROM release_forecasts WHERE series = 'eia_crude' AND release_at >= '2016-01-01' AND release_at < '2022-01-01' ORDER BY release_at`) as { release_at: Date; forecast: number | null; actual: number | null }[];
    const pub = ((await sql`SELECT a.official_release_at AS at, v.change FROM eia_report_arrivals a JOIN eia_report_values v ON v.event_id = a.event_id AND v.series_id = 'WPSR:T1:COMMERCIAL_EXCLUDING_SPR' WHERE a.official_release_at IS NOT NULL`) as { at: Date; change: number | null }[]).flatMap((r) => (r.change === null ? [] : [[new Date(r.at).getTime(), Number(r.change)] as const]));

    const rows: LedgerRow[] = [];
    for (const [i, f] of fc.entries()) {
      const at = new Date(f.release_at).getTime();
      const actual = pub.find(([t]) => Math.abs(t - at) < 20 * 3600_000)?.[1] ?? f.actual ?? undefined;
      const b = (await sql`SELECT extract(epoch FROM time)::int AS t, open, high, low, close, volume FROM external_bars WHERE source = 'dukascopy' AND symbol = ${symbol} AND time >= ${new Date(at - BEFORE_MIN * 60_000)} AND time < ${new Date(at + AFTER_MIN * 60_000)} ORDER BY time`) as any[];
      const bars: Bar[] = b.map((r) => ({ time: r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
      rows.push(simulateDay({ at, forecast: f.forecast ?? undefined, actual, bars }, cfg));
      if (i % 10 === 0 || i === fc.length - 1) status("running", i + 1, fc.length, rows.at(-1)!.date);
    }

    const traded = rows.filter((r) => r.status === "traded");
    const rs = traded.map((r) => r.r!);
    const s = summarizeR(rs);
    const test = randomSideP(traded.filter((r) => r.rOtherSide !== undefined).map((r): Day => ({ long: r.side === "long" ? r.r! : r.rOtherSide!, short: r.side === "short" ? r.r! : r.rOtherSide!, side: r.side! })));
    const reasons: Record<string, number> = {};
    for (const r of rows) if (r.status !== "traded") reasons[r.status] = (reasons[r.status] ?? 0) + 1;
    const f3 = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? "n/a" : x.toFixed(3));
    const md = [
      `# EIA crude paper simulator, ${symbol}, 2016-2021 (development only)`,
      `Window: ${BEFORE_MIN} min before to ${AFTER_MIN} min after the release; one side per day; ${cfg.breakout ? `breakout entry on ${cfg.breakout.candleMin}-minute closes beyond the pre-release hour's range (${cfg.breakout.side}, until ${cfg.breakout.cutoffMin} min)` : `entry ${cfg.delayMin} min after the print`}; R ${cfg.rPct}%; slip ${cfg.slip}; surprise threshold ${cfg.threshold} MB. R before costs.`,
      `Report days ${rows.length}; traded ${traded.length}; not traded: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`,
      `Mean R ${f3(s.mean)} (95% ${s.ci ? `${f3(s.ci[0])} to ${f3(s.ci[1])}` : "n/a"}), win ${f3(s.winRate * 100)}%, profit factor ${f3(s.profitFactor)}, max drawdown ${f3(s.maxDrawdown)} R, random-side p ${f3(test?.p)}.`,
    ].join("\n");
    writeFileSync(`${out}/sim-ledger.csv`, ledgerCsv(rows));
    writeFileSync(`${out}/sim-summary.md`, md);
    console.log("\n" + md);
    status("done", rows.length, rows.length, `${out}/sim-ledger.csv`);
  } catch (e) {
    status("error", 0, 1, (e as Error).message);
    process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

if (import.meta.main) await main();
