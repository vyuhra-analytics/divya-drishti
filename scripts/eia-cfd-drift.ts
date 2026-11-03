// Step-2 study: does the direction of the EIA surprise carry information about price, with NO stops, targets or R?
// For each report day the move from a fixed entry time to a fixed later time is measured (percent of the entry price) and signed in the surprise's
// direction (a draw below the forecast = up). Development years only (2016-2021); external_bars is read through a read-only connection.
//   bun run --env-file=.env scripts/eia-cfd-drift.ts [--entries=1,5,15] [--exits=30,60,90] [--thresholds=2,3] [--out=DIR] [--symbol=lightcmdusd]
import { SQL } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Bar } from "../packages/shared/src/index";
import { bootstrapCI, mean, rng } from "./eia-cfd-stats";

export const HOLDOUT_FROM = Date.parse("2022-01-01T00:00:00Z");

/** price at minute `min` after the release: the open of the first traded bar at or after it, within 5 minutes (Dukascopy volume 0 = nothing traded) */
export function priceAt(bars: readonly Bar[], releaseSec: number, min: number): number | undefined {
  const t = releaseSec + min * 60;
  return bars.find((b) => b.time >= t && b.time <= t + 300 && b.volume > 0)?.open;
}

/** move in percent from the price at `entry` minutes to the price at `exit` minutes; undefined when either price is missing */
export function movePct(bars: readonly Bar[], releaseSec: number, entry: number, exit: number): number | undefined {
  const a = priceAt(bars, releaseSec, entry);
  const b = priceAt(bars, releaseSec, exit);
  return a === undefined || b === undefined ? undefined : ((b - a) / a) * 100;
}

/** a draw below the forecast (negative surprise) is bullish: +1; a build above is -1 */
export const dir = (surprise: number) => (surprise < 0 ? 1 : surprise > 0 ? -1 : 0);

export interface DriftDay {
  at: number;
  surprise: number;
  /** raw move in percent, keyed "entry-exit" */
  moves: Record<string, number | undefined>;
}

export interface DriftRow {
  n: number;
  /** average move signed in the surprise's direction, percent */
  mean: number;
  ci: [number, number] | undefined;
  /** share of days the signed move was positive */
  up: number;
  /** one-sided: share of random-sign draws (same days, same sizes) that averaged at least this much */
  p: number;
}

/** Signed-move test. The null is "the surprise's sign says nothing": give every day a random sign and compare. */
export function signedStats(days: readonly { surprise: number; move: number }[], runs = 5000, seed = 1): DriftRow | undefined {
  const xs = days.filter((d) => dir(d.surprise) !== 0);
  if (!xs.length) return undefined;
  const signed = xs.map((d) => dir(d.surprise) * d.move);
  const actual = mean(signed);
  const r = rng(seed);
  let atLeast = 0;
  for (let i = 0; i < runs; i++) if (mean(xs.map((d) => (r() < 0.5 ? d.move : -d.move))) >= actual) atLeast++;
  return { n: xs.length, mean: actual, ci: bootstrapCI(signed), up: signed.filter((x) => x > 0).length / signed.length, p: (atLeast + 1) / (runs + 1) };
}

/** Pearson correlation of surprise with the raw move over all days, with a two-sided permutation p (moves shuffled against the surprises). */
export function correlation(days: readonly { surprise: number; move: number }[], runs = 5000, seed = 1): { n: number; r: number; p: number } | undefined {
  if (days.length < 5) return undefined;
  const xs = days.map((d) => d.surprise);
  const ys = days.map((d) => d.move);
  const corr = (b: readonly number[]) => {
    const mx = mean(xs);
    const my = mean(b);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (b[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (b[i] - my) ** 2;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  };
  const actual = corr(ys);
  const rand = rng(seed);
  const shuffled = [...ys];
  let atLeast = 0;
  for (let i = 0; i < runs; i++) {
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    if (Math.abs(corr(shuffled)) >= Math.abs(actual)) atLeast++;
  }
  return { n: days.length, r: actual, p: (atLeast + 1) / (runs + 1) };
}

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const nums = (k: string, d: string) => (arg(k) ?? d).split(",").map(Number);
  const entries = nums("entries", "1,5,15");
  const exits = nums("exits", "30,60,90");
  const thresholds = nums("thresholds", "2,3");
  const out = arg("out") ?? "I:/divya-drishti-data/dukascopy/backtest/drift";
  const symbol = arg("symbol") ?? "lightcmdusd";
  mkdirSync(out, { recursive: true });

  // read-only: a write attempt errors
  const sql = new SQL(process.env.DATABASE_URL!, { connection: { default_transaction_read_only: "on" } });
  const ro = (await sql`SHOW default_transaction_read_only`) as { default_transaction_read_only: string }[];
  if (ro[0]?.default_transaction_read_only !== "on") throw new Error("connection is not read-only");

  const fc = (await sql`SELECT release_at, forecast, actual FROM release_forecasts WHERE series = 'eia_crude' AND release_at >= '2016-01-01' AND release_at < '2022-01-01' ORDER BY release_at`) as { release_at: Date; forecast: number | null; actual: number | null }[];
  const pub = ((await sql`SELECT a.official_release_at AS at, v.change FROM eia_report_arrivals a JOIN eia_report_values v ON v.event_id = a.event_id AND v.series_id = 'WPSR:T1:COMMERCIAL_EXCLUDING_SPR' WHERE a.official_release_at IS NOT NULL`) as { at: Date; change: number | null }[]).flatMap((r) => (r.change === null ? [] : [[new Date(r.at).getTime(), Number(r.change)] as const]));

  const days: DriftDay[] = [];
  let skipped = 0;
  const last = Math.max(...exits);
  for (const f of fc) {
    const at = new Date(f.release_at).getTime();
    if (at >= HOLDOUT_FROM) throw new Error("holdout day refused");
    const actual = pub.find(([t]) => Math.abs(t - at) < 20 * 3600_000)?.[1] ?? f.actual;
    if (f.forecast === null || actual === null || actual === undefined) { skipped++; continue; }
    const rows = (await sql`SELECT extract(epoch FROM time)::int AS t, open, high, low, close, volume FROM external_bars WHERE source = 'dukascopy' AND symbol = ${symbol} AND time >= ${new Date(at)} AND time <= ${new Date(at + (last + 10) * 60_000)} ORDER BY time`) as any[];
    const bars: Bar[] = rows.map((r) => ({ time: r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
    const moves: DriftDay["moves"] = {};
    for (const e of entries) for (const x of exits) if (x > e) moves[`${e}-${x}`] = movePct(bars, at / 1000, e, x);
    days.push({ at, surprise: actual - f.forecast, moves });
  }
  await sql.close();

  const fmt = (x: number | undefined, d = 3) => (x === undefined || Number.isNaN(x) ? "n/a" : x.toFixed(d));
  const lines: string[] = [];
  const log = (s = "") => lines.push(s);
  log(`# EIA surprise vs price drift, ${symbol}, development 2016-2021 (no stops, no targets, no R)`);
  log(`Move = percent change from the price at minute E after the print to the price at minute X, signed so that a draw below the forecast counts as up. Report days read: ${fc.length}; without forecast or actual: ${skipped}; used: ${days.length}.`);
  log(`Signed mean near 0 with p large = the surprise's direction says nothing. Columns: mean signed move (%), 95% interval, share of days positive, p (random sign, one-sided).`);
  const head = "| Entry-Exit | Days | Mean signed move % | 95% interval | Positive | p |\n|---|---|---|---|---|---|";
  const results: unknown[] = [];
  const pairs = entries.flatMap((e) => exits.filter((x) => x > e).map((x) => `${e}-${x}`));
  const usable = (key: string) => days.flatMap((d) => (d.moves[key] === undefined ? [] : [{ surprise: d.surprise, move: d.moves[key]! }]));

  for (const th of thresholds) {
    log(`\n## Surprise >= ${th} MB (signal days)\n${head}`);
    for (const key of pairs) {
      const s = signedStats(usable(key).filter((d) => Math.abs(d.surprise) >= th));
      log(`| ${key} | ${s?.n ?? 0} | ${fmt(s?.mean)} | ${s?.ci ? `${fmt(s.ci[0])} to ${fmt(s.ci[1])}` : "n/a"} | ${s ? fmt(s.up * 100, 0) + "%" : "n/a"} | ${fmt(s?.p)} |`);
      results.push({ group: `>=${th}`, key, ...s });
    }
  }
  log(`\n## Control: surprise under 1 MB (should show nothing)\n${head}`);
  for (const key of pairs) {
    const s = signedStats(usable(key).filter((d) => Math.abs(d.surprise) < 1));
    log(`| ${key} | ${s?.n ?? 0} | ${fmt(s?.mean)} | ${s?.ci ? `${fmt(s.ci[0])} to ${fmt(s.ci[1])}` : "n/a"} | ${s ? fmt(s.up * 100, 0) + "%" : "n/a"} | ${fmt(s?.p)} |`);
    results.push({ group: "<1", key, ...s });
  }
  log(`\n## All days: correlation of the surprise (MB) with the raw move\n| Entry-Exit | Days | Correlation | p (permutation, two-sided) | Average raw move % (drift of the window) |\n|---|---|---|---|---|`);
  for (const key of pairs) {
    const u = usable(key);
    const c = correlation(u);
    log(`| ${key} | ${c?.n ?? 0} | ${fmt(c?.r)} | ${fmt(c?.p)} | ${fmt(mean(u.map((d) => d.move)))} |`);
    results.push({ group: "all", key, ...c });
  }
  log(`\nTests run: ${pairs.length} windows x ${thresholds.length + 1} groups on the same days; with that many, one p near 0.05 is expected by chance.`);

  const md = lines.join("\n");
  writeFileSync(`${out}/drift-results.md`, md);
  writeFileSync(`${out}/drift-results.json`, JSON.stringify({ entries, exits, thresholds, used: days.length, results }, null, 2));
  console.log(md);
}

if (import.meta.main) await main();
