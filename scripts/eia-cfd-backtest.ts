// EIA crude report-day backtest on the Dukascopy crude CFD (external_bars, 1-minute bid, UTC). Reuses the app's own replay (`replayReportTrade`) so the rules
// are the ones the screens use; results are in R BEFORE costs (the CFD has no MCX cost stack), slippage is charged on every fill.
//   bun run --env-file=.env scripts/eia-cfd-backtest.ts [--thresholds=2,3,4,5] [--delay=1] [--hold=90] [--rpct=0.5] [--slip=0.03] [--out=DIR]
//   bun run --env-file=.env scripts/eia-cfd-backtest.ts --holdout=3      run ONE threshold on 2022 onward; allowed once (a lock file stops a second look)
// Development years are 2016-2021. Progress is written to <out>/status.json after every step and appended to <out>/progress.log.
import { SQL } from "bun";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { replayReportTrade, reportSignal, type ReportTrade } from "../packages/shared/src/eiaStrategy";
import type { Bar } from "../packages/shared/src/index";
import { mean, randomSideP, summarizeR, type Day } from "./eia-cfd-stats";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const out = arg("out") ?? "I:/divya-drishti-data/dukascopy/backtest";
const symbol = arg("symbol") ?? "lightcmdusd";
const holdout = arg("holdout");
const thresholds = (arg("thresholds") ?? holdout ?? "2,3,4,5").split(",").map(Number);
const cfg = { rPct: Number(arg("rpct") ?? 0.5), delayMin: Number(arg("delay") ?? 1), holdMin: Number(arg("hold") ?? 90), slip: Number(arg("slip") ?? 0.03), units: 1, lotsPerLeg: 1 };
const SPLIT = Date.parse("2022-01-01T00:00:00Z");
mkdirSync(out, { recursive: true });

const started = Date.now();
const status = (state: "running" | "done" | "error", phase: string, done: number, total: number, note = "") => {
  const elapsed = (Date.now() - started) / 1000;
  const s = { state, phase, done, total, pct: total ? Math.round((done / total) * 100) : 0, note, elapsedSec: Math.round(elapsed), etaSec: done > 0 && total > done ? Math.round((elapsed / done) * (total - done)) : 0, updatedAt: new Date().toISOString() };
  writeFileSync(`${out}/status.json`, JSON.stringify(s, null, 2));
  const line = `${s.updatedAt} ${state} ${phase} ${done}/${total} ${note}`;
  appendFileSync(`${out}/progress.log`, line + "\n");
  console.log(line);
};

interface Release {
  at: number;
  surprise: number;
  long: ReportTrade | string;
  short: ReportTrade | string;
}
/** the average of the two legs, in R, before costs (the legs are equal) */
const rOf = (t: ReportTrade | string) => (typeof t === "string" ? undefined : (t.legs[0].r + t.legs[1].r) / 2);

async function main() {
  const lockFile = `${out}/holdout.lock`;
  if (holdout && existsSync(lockFile)) throw new Error(`the holdout was already run (${lockFile}); it is allowed once`);
  const sql = new SQL(process.env.DATABASE_URL!);
  status("running", "releases", 0, 1, "reading forecasts");
  const fc = (await sql`SELECT release_at, forecast, actual FROM release_forecasts WHERE series = 'eia_crude' AND release_at >= '2016-01-01' AND release_at < now() ORDER BY release_at`) as { release_at: Date; forecast: number | null; actual: number | null }[];
  const pub = ((await sql`SELECT a.official_release_at AS at, v.change FROM eia_report_arrivals a JOIN eia_report_values v ON v.event_id = a.event_id AND v.series_id = 'WPSR:T1:COMMERCIAL_EXCLUDING_SPR' WHERE a.official_release_at IS NOT NULL`) as { at: Date; change: number | null }[]).flatMap((r) => (r.change === null ? [] : [[new Date(r.at).getTime(), Number(r.change)] as const]));

  const wanted = fc.filter((f) => (holdout ? new Date(f.release_at).getTime() >= SPLIT : new Date(f.release_at).getTime() < SPLIT));
  const releases: Release[] = [];
  let noForecast = 0;
  for (const [i, f] of wanted.entries()) {
    const at = new Date(f.release_at).getTime();
    const actual = pub.find(([t]) => Math.abs(t - at) < 20 * 3600_000)?.[1] ?? f.actual;
    if (f.forecast === null || actual === null || actual === undefined) {
      noForecast++;
      continue;
    }
    const rows = (await sql`SELECT extract(epoch FROM time)::int AS t, open, high, low, close, volume FROM external_bars WHERE source = 'dukascopy' AND symbol = ${symbol} AND time >= ${new Date(at - 3600_000)} AND time <= ${new Date(at + (cfg.holdMin + 10) * 60_000)} ORDER BY time`) as any[];
    const bars: Bar[] = rows.map((r) => ({ time: r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
    releases.push({ at, surprise: actual - f.forecast, long: replayReportTrade(bars, at / 1000, "long", cfg), short: replayReportTrade(bars, at / 1000, "short", cfg) });
    if (i % 10 === 0 || i === wanted.length - 1) status("running", "replay", i + 1, wanted.length, new Date(at).toISOString().slice(0, 10));
  }
  await sql.close();

  // both sides share the same entry bar, so a skip applies to both
  const skipped: Record<string, number> = {};
  const usable = releases.filter((r) => {
    if (typeof r.long === "string") skipped[r.long] = (skipped[r.long] ?? 0) + 1;
    return typeof r.long !== "string" && typeof r.short !== "string";
  });

  const lines: string[] = [];
  const log = (s = "") => lines.push(s);
  const fmt = (x: number | undefined, d = 3) => (x === undefined || Number.isNaN(x) ? "n/a" : x.toFixed(d));
  const sideOf = (r: Release) => reportSignal(r.surprise, 0.0001)!;
  const row = (label: string, days: Release[], withTest: boolean) => {
    const rs = days.map((r) => rOf(r[sideOf(r)])!);
    const s = summarizeR(rs);
    const test = withTest ? randomSideP(days.map((r): Day => ({ long: rOf(r.long)!, short: rOf(r.short)!, side: sideOf(r) }))) : undefined;
    log(`| ${label} | ${s.n} | ${fmt(s.mean)} | ${s.ci ? `${fmt(s.ci[0])} to ${fmt(s.ci[1])}` : "n/a"} | ${fmt(s.winRate * 100, 0)}% | ${fmt(s.profitFactor, 2)} | ${fmt(s.maxDrawdown, 1)} | ${test ? fmt(test.p, 3) : ""} |`);
    return { label, ...s, p: test?.p };
  };
  const head = "| Set | Trades | Mean R | 95% interval | Win | Profit factor | Max drawdown R | p (random side) |\n|---|---|---|---|---|---|---|---|";
  const results: unknown[] = [];

  log(`# EIA crude report-day backtest on ${symbol} (${holdout ? "HOLDOUT 2022 onward" : "development 2016-2021"})`);
  log(`Rules: delay ${cfg.delayMin} min, hold ${cfg.holdMin} min, R ${cfg.rPct}% of entry, slip ${cfg.slip} per fill, stop 1R, legs at +1R and +2R. Results in R BEFORE costs.`);
  const skipText = Object.entries(skipped).map(([k, v]) => `${k}: ${v}`).join(", ");
  log(`Releases read: ${wanted.length}; without forecast or actual: ${noForecast}; no tradable bars: ${releases.length - usable.length}${skipText ? ` (${skipText})` : ""}; usable: ${usable.length}.`);
  log(`\n## Threshold ladder (the declared variants)\n${head}`);
  for (const th of thresholds) results.push(row(`surprise >= ${th} MB`, usable.filter((r) => Math.abs(r.surprise) >= th), true));
  log(`\n## Bands, descriptive (does the edge grow with the surprise?)\n${head}`);
  const edges = [0, ...thresholds.filter((t) => t > 0), Infinity];
  for (let i = 0; i < edges.length - 1; i++) results.push(row(`${edges[i]} to ${edges[i + 1]} MB`, usable.filter((r) => Math.abs(r.surprise) > 0 && Math.abs(r.surprise) >= edges[i] && Math.abs(r.surprise) < edges[i + 1]), false));
  for (const th of thresholds) {
    const days = usable.filter((r) => Math.abs(r.surprise) >= th);
    log(`\n## By year, surprise >= ${th} MB\n| Year | Trades | Mean R |\n|---|---|---|`);
    for (const y of [...new Set(days.map((r) => new Date(r.at).getUTCFullYear()))].sort()) {
      const rs = days.filter((r) => new Date(r.at).getUTCFullYear() === y).map((r) => rOf(r[sideOf(r)])!);
      log(`| ${y} | ${rs.length} | ${fmt(mean(rs))} |`);
    }
    const side = (s: "long" | "short") => days.filter((r) => sideOf(r) === s).map((r) => rOf(r[s])!);
    log(`Long ${side("long").length} trades mean ${fmt(mean(side("long")))} R; short ${side("short").length} trades mean ${fmt(mean(side("short")))} R.`);
  }
  log(`\nVariants tried: ${thresholds.length}. The random-side p is the share of 5,000 random-direction runs on the same days that did at least as well; a small p says the direction matters, not that the strategy pays after costs.`);

  const md = lines.join("\n");
  const tag = holdout ? "holdout" : "develop";
  writeFileSync(`${out}/results-${tag}.md`, md);
  writeFileSync(`${out}/results-${tag}.json`, JSON.stringify({ cfg, thresholds, noForecast, skipped, usable: usable.length, results }, null, 2));
  if (holdout) writeFileSync(lockFile, new Date().toISOString());
  console.log("\n" + md);
  status("done", "report", 1, 1, `${out}/results-${tag}.md`);
}

main().catch((e) => {
  status("error", "failed", 0, 1, (e as Error).message);
  process.exit(1);
});
