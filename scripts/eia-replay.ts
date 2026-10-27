// Replay the EIA report-day strategy over the one-minute candles we hold (option_candles, side FUT) and print every release and a summary.
//   bun run --env-file=.env scripts/eia-replay.ts [--report=WPSR|WNGSR] [--underlying=CRUDEOILM] [--rpct=0.3] [--delay=1] [--hold=60] [--slip=1]
//                                                   [--threshold=3] [--since=2026-04-25]
// R is 0.5% of the entry price (the owner's definition). The contract is the one with the most volume in the
// hour BEFORE the release (nothing after it is used). A release with no traded minute before it (a contract we never held, or one not yet trading) is
// skipped and counted, never filled with a guess. The sensitivity grid is for reading how much the answer depends on R, NOT for picking the best R.
import { SQL } from "bun";
import { lotUnits, replayReportTrade, reportSignal, summarizeReplay, type Bar, type ReportSkip, type ReportTrade } from "../packages/shared/src";

const arg = (n: string, d: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const report = arg("report", "WPSR");
const underlying = arg("underlying", report === "WPSR" ? "CRUDEOILM" : "NATGASMINI");
const rPct = Number(arg("rpct", "0.5"));
const delayMin = Number(arg("delay", "1"));
const holdMin = Number(arg("hold", "60"));
const slip = Number(arg("slip", report === "WPSR" ? "1" : "0.1"));
const threshold = Number(arg("threshold", report === "WPSR" ? "3" : "5"));
const since = arg("since", "2026-04-25");
const units = lotUnits(`MCX:${underlying}`);
if (!units) throw new Error(`unknown underlying ${underlying}`);

const sql = new SQL(process.env.DATABASE_URL!);
const series = report === "WPSR" ? "eia_crude" : "eia_gas";
const fc = (await sql`SELECT release_at, forecast, actual FROM release_forecasts WHERE series = ${series} AND release_at >= ${since}::timestamptz AND release_at < now() ORDER BY release_at`) as { release_at: Date; forecast: number | null; actual: number | null }[];
const published = new Map<number, number>();
if (report === "WPSR") {
  const rows = (await sql`SELECT a.official_release_at AS at, v.change FROM eia_report_arrivals a JOIN eia_report_values v ON v.event_id = a.event_id AND v.series_id = 'WPSR:T1:COMMERCIAL_EXCLUDING_SPR' WHERE a.official_release_at IS NOT NULL`) as { at: Date; change: number | null }[];
  for (const r of rows) if (r.change !== null) published.set(new Date(r.at).getTime(), Number(r.change));
}
const keys = ((await sql`SELECT key FROM option_contracts WHERE side = 'FUT' AND underlying = ${underlying}`) as { key: string }[]).map((r) => r.key);

interface Row { at: number; surprise?: number; result: ReportTrade | ReportSkip; contract?: string }
async function releaseBars(at: number): Promise<{ key: string; bars: Bar[] } | undefined> {
  const from = new Date(at - 60 * 60_000);
  const to = new Date(at + (holdMin + 10) * 60_000);
  const rows = (await sql`SELECT key, extract(epoch FROM time)::int AS t, open, high, low, close, volume FROM option_candles WHERE key IN ${sql(keys)} AND time >= ${from} AND time <= ${to} ORDER BY time`) as any[];
  const by = new Map<string, Bar[]>();
  const before = new Map<string, number>();
  for (const r of rows) {
    (by.get(r.key) ?? by.set(r.key, []).get(r.key)!).push({ time: r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume });
    if (r.t * 1000 < at) before.set(r.key, (before.get(r.key) ?? 0) + Number(r.volume)); // causal: only the hour before the release picks the contract
  }
  const pick = [...before.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return pick ? { key: pick, bars: by.get(pick)! } : undefined;
}

const cache = new Map<number, { key: string; bars: Bar[] } | undefined>();
async function run(cfgR: number): Promise<Row[]> {
  const out: Row[] = [];
  for (const f of fc) {
    const at = new Date(f.release_at).getTime();
    const actual = report === "WPSR" ? ([...published.entries()].find(([t]) => Math.abs(t - at) < 20 * 3600_000)?.[1] ?? f.actual) : f.actual;
    const surprise = f.forecast !== null && actual !== null && actual !== undefined ? actual - f.forecast : undefined;
    const side = reportSignal(surprise, threshold);
    if (!cache.has(at)) cache.set(at, await releaseBars(at));
    const found = cache.get(at);
    const result = replayReportTrade(found?.bars ?? [], at / 1000, side, { rPct: cfgR, delayMin, holdMin, slip, units, lotsPerLeg: 1 });
    out.push({ at, surprise, result, contract: found?.key });
  }
  return out;
}

const rows = await run(rPct);
console.log(`${report} on ${underlying} (${units} units a lot), threshold ${threshold}, R = ${rPct}% of entry (owner: 0.5%), entry ${delayMin} min after the release, hold ${holdMin} min, slippage ${slip} points, 1 lot per leg`);
console.log("date        surprise  side   result");
for (const r of rows) {
  const d = new Date(r.at).toISOString().slice(0, 10);
  const s = r.surprise === undefined ? "   n/a" : r.surprise.toFixed(2).padStart(7);
  if (typeof r.result === "string") { console.log(d, s, "       ", r.result); continue; }
  const t = r.result;
  console.log(d, s, t.side.padEnd(6), `entry ${t.entry.toFixed(1)}  legs ${t.legs.map((l) => `${l.reason}${l.r >= 0 ? "+" : ""}${l.r.toFixed(1)}R`).join(" ")}  net ${t.net.toFixed(0).padStart(6)} (${t.netR.toFixed(2)}R, costs ${t.costs.toFixed(0)})`);
}
const sum = summarizeReplay(rows.map((r) => r.result));
console.log(`\nreleases ${rows.length} | traded ${sum.trades} | skipped ${JSON.stringify(sum.skipped)}`);
if (sum.trades) console.log(`wins ${sum.winners}/${sum.trades} | net ${sum.netTotal.toFixed(0)} (gross ${sum.grossTotal.toFixed(0)}, costs ${sum.costsTotal.toFixed(0)}) | avg net ${sum.avgNetR!.toFixed(2)}R | profit factor ${sum.profitFactor?.toFixed(2) ?? "n/a"} | long ${sum.bySide.long.trades} (${sum.bySide.long.net.toFixed(0)}), short ${sum.bySide.short.trades} (${sum.bySide.short.net.toFixed(0)})`);
console.log("\nsensitivity to R (read it, do not pick the best):");
for (const v of [0.15, 0.3, 0.5, 0.75, 1]) {
  const s = summarizeReplay((await run(v)).map((r) => r.result));
  console.log(`  R ${String(v).padStart(4)}%  traded ${s.trades}  wins ${s.winners}  net ${s.netTotal.toFixed(0).padStart(7)}  avg ${s.avgNetR?.toFixed(2) ?? "n/a"}R`);
}
await sql.close();
