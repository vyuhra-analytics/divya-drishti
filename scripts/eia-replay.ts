// Replay the EIA report-day strategy over the one-minute candles we hold (option_candles, side FUT) and print every release and a summary. The same
// code serves the Strategy tester panel (GET /research/eia-replay), see apps/drishti-core-api/src/eia-replay.run.ts.
//   bun run --env-file=.env scripts/eia-replay.ts [--report=WPSR|WNGSR] [--underlying=CRUDEOILM] [--rpct=0.5] [--delay=1] [--hold=60] [--slip=1]
//                                                   [--threshold=3] [--since=2026-04-25]
// R is 0.5% of the entry price (the owner's definition). The contract is the one with the most volume in the hour BEFORE the release. The sensitivity
// grid is for reading how much the answer depends on R, NOT for picking the best R.
import { SQL } from "bun";
import { defaultReplay, runEiaReplay } from "../apps/drishti-core-api/src/eia-replay.run";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const report = (arg("report") ?? "WPSR") as "WPSR" | "WNGSR";
const d = defaultReplay(report);
const p = {
  report,
  underlying: (arg("underlying") ?? d.underlying) as typeof d.underlying,
  rPct: Number(arg("rpct") ?? d.rPct),
  delayMin: Number(arg("delay") ?? d.delayMin),
  holdMin: Number(arg("hold") ?? d.holdMin),
  slip: Number(arg("slip") ?? d.slip),
  threshold: Number(arg("threshold") ?? d.threshold),
  since: arg("since") ?? d.since,
};

const sql = new SQL(process.env.DATABASE_URL!);
const r = await runEiaReplay(sql, p, true);
console.log(`${p.report} on ${p.underlying} (${r.units} units a lot), threshold ${p.threshold}, R = ${p.rPct}% of entry, entry ${p.delayMin} min after the release, hold ${p.holdMin} min, slippage ${p.slip} points, 1 lot per leg`);
console.log("date        surprise  side   result");
for (const row of r.rows) {
  const day = new Date(row.at).toISOString().slice(0, 10);
  const s = row.surprise === undefined ? "   n/a" : row.surprise.toFixed(2).padStart(7);
  if (typeof row.result === "string") {
    console.log(day, s, "       ", row.result);
    continue;
  }
  const t = row.result;
  console.log(day, s, t.side.padEnd(6), `entry ${t.entry.toFixed(1)}  legs ${t.legs.map((l) => `${l.reason}${l.r >= 0 ? "+" : ""}${l.r.toFixed(1)}R`).join(" ")}  net ${t.net.toFixed(0).padStart(6)} (${t.netR.toFixed(2)}R, costs ${t.costs.toFixed(0)})`);
}
const sum = r.summary;
console.log(`\nreleases ${r.rows.length} | traded ${sum.trades} | skipped ${JSON.stringify(sum.skipped)}`);
if (sum.trades) console.log(`wins ${sum.winners}/${sum.trades} | net ${sum.netTotal.toFixed(0)} (gross ${sum.grossTotal.toFixed(0)}, costs ${sum.costsTotal.toFixed(0)}) | avg net ${sum.avgNetR!.toFixed(2)}R | profit factor ${sum.profitFactor?.toFixed(2) ?? "n/a"} | long ${sum.bySide.long.trades} (${sum.bySide.long.net.toFixed(0)}), short ${sum.bySide.short.trades} (${sum.bySide.short.net.toFixed(0)})`);
console.log("\nsensitivity to R (read it, do not pick the best):");
for (const s of r.sensitivity ?? []) console.log(`  R ${String(s.rPct).padStart(4)}%  traded ${s.summary.trades}  wins ${s.summary.winners}  net ${s.summary.netTotal.toFixed(0).padStart(7)}  avg ${s.summary.avgNetR?.toFixed(2) ?? "n/a"}R`);
await sql.close();
