// What happened at an EIA release, read back from the running stack in one go: did the watcher store the report, how many seconds after the official time, what
// was the number against the forecast and the rule's side, how the market moved, and (for MCX) the recorded spread and estimated flow. Read-only; it asks the
// API's own routes, so nothing here can disagree with the screens.
//   bun run scripts/eia-release-check.ts [WPSR|WNGSR] [--api=http://localhost:3001]
const arg = process.argv.slice(2);
const report = (arg.find((a) => a === "WPSR" || a === "WNGSR") ?? "WPSR") as "WPSR" | "WNGSR";
const api = (arg.find((a) => a.startsWith("--api="))?.slice(6) ?? "http://localhost:3001").replace(/\/$/, "");

async function get(path: string): Promise<any> {
  const r = await fetch(`${api}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
const ist = (iso: string | number | undefined) => (iso === undefined ? "?" : new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }) + " IST");
const pct = (v: number | undefined) => (v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

const state = await get(`/eia-report?report=${report}`);
const arrivalAll = await get("/eia-report/arrivals");
// the log is newest-stored first and short, so the week being read is looked up in it rather than assumed to be first
const arrival = (Array.isArray(arrivalAll) ? arrivalAll : []).find((a: any) => a.report === report && a.weekEnding === state.weekEnding);

console.log(`\n=== ${report}: week ending ${state.weekEnding} ===`);
if (arrival) {
  const secs = Math.round(arrival.delayMs / 1000);
  console.log(`official release  ${ist(arrival.officialReleaseAt)}`);
  console.log(`stored by us      ${ist(arrival.firstStoredAt)}   ${arrival.backfilled ? "(BACKFILLED after the fact: the live watcher did not catch it)" : `${secs} s after the official time (${arrival.rows} rows)`}`);
} else console.log("no arrival recorded for this week in the newest 20 entries of the log: the watcher has not stored it live yet (or it was stored long ago)");

const h = state.analysis?.headline;
if (h) {
  console.log(`\nnumber            ${h.label}: ${h.change} ${h.unit} (level ${h.level})`);
  console.log(`forecast          ${h.forecast ?? "none"} ${state.forecast?.source ? `(${state.forecast.source})` : ""}`);
  console.log(`surprise          ${h.surprise ?? "—"}  threshold ${h.threshold}  ->  ${h.sideText}`);
}

try {
  const art = await get(`/eia-report/article?report=${report}`);
  const rx = art.facts?.reaction ?? {};
  console.log("\nmarket reaction (from the close of the candle before the release):");
  for (const [k, v] of Object.entries<any>(rx)) {
    if (!v?.moves) {
      console.log(`  ${k}: ${v?.note ?? "no candles"}`);
      continue;
    }
    const m = v.moves;
    console.log(`  ${v.label}: 1m ${pct(m.m1?.pct)}  5m ${pct(m.m5?.pct)}  15m ${pct(m.m15?.pct)}  30m ${pct(m.m30?.pct)}  60m ${pct(m.m60?.pct)} | first 15 min swing ${v.firstSwing15} (up ${v.maxUp15}, down ${v.maxDown15}) | first-5-min volume ${v.volumeFirst5} (${v.volumeRatio}x the hour before) | ${v.minutesCovered} min covered`);
    if (v.micro) console.log(`    recorded feed: spread ${JSON.stringify(v.micro.spread ?? v.micro)}`.slice(0, 220));
  }
  const notes: string[] = art.facts?.notes ?? [];
  if (notes.length) console.log(`\nnotes: ${notes.join(" | ")}`.slice(0, 600));
} catch (e) {
  console.log(`\nreaction not available yet: ${(e as Error).message}`);
}

// the report-day screen's own inputs, so a problem there is seen here too
try {
  const fc = await get("/eia-report/forecasts?weeks=26");
  const next = fc.releases?.[0];
  console.log(`\nnext release in the forecast table: ${ist(next?.releaseAt)} ${next?.upcoming ? "(upcoming)" : "(past)"}`);
} catch {
  /* optional */
}
console.log("");
