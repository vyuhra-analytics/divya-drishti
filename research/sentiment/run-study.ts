// The headline sentiment study (research/sentiment, PREREGISTRATION.md deviations D1 to D3).
//   bun --env-file=.env research/sentiment/run-study.ts [--from=2026-04-23] [--to=2026-10-23]          audit only (the default): the data gate
//   bun --env-file=.env research/sentiment/run-study.ts --run [--from=...] [--to=...]                  run the pre-registered experiments, ONLY if every gate passes
// Nothing is tuned here. The tone is the fixed crude lexicon, the horizons are 60 minutes and 1 day, the thresholds are the ones written down before any result.
import { SQL } from "bun";
import { clExpiries } from "../../packages/shared/src/clExpiry";
import { crudeTone } from "../../packages/shared/src/crudeLexicon";
import { batchTimes } from "../../packages/shared/src/gdelt";
import { buildObservations, holm, icTest, lookAheadShift, shuffledControl, type HBar, type Headline, type Observation } from "../../packages/shared/src/sentimentStudy";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const run = process.argv.includes("--run");
const DAY = 86_400_000;
const date = (s: string | undefined, fallback: number) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : fallback);
const to = date(arg("to"), Date.parse("2026-10-23T00:00:00Z"));
const from = date(arg("from"), Date.parse("2026-04-23T00:00:00Z"));

const sql = new SQL(process.env.DATABASE_URL!);
const rows = (await sql`SELECT seen_at, title FROM gdelt_headlines WHERE seen_at >= ${new Date(from).toISOString()} AND seen_at < ${new Date(to).toISOString()} ORDER BY seen_at`) as { seen_at: Date; title: string }[];
const headlines: Headline[] = rows.map((r) => ({ at: new Date(r.seen_at).getTime(), title: r.title }));
const barRows = (await sql`SELECT time, open, close FROM cl_hourly ORDER BY time`) as { time: Date; open: number; close: number }[];
const allBars: HBar[] = barRows.map((b) => ({ time: new Date(b.time).getTime() / 1000, open: b.open, close: b.close }));
const bars = allBars.filter((b) => b.time * 1000 < to + 3 * DAY); // never the forming bar
const done = (await sql`SELECT batch_at, status FROM gdelt_batches WHERE batch_at >= ${new Date(from).toISOString()} AND batch_at < ${new Date(to).toISOString()}`) as { batch_at: Date; status: string }[];
await sql.close();

const expiries = clExpiries(from - 5 * DAY, to + 5 * DAY);
const obs = buildObservations(headlines, bars, { tone: (t) => crudeTone(t).tone, expiries });
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- the gate
const gates: { name: string; found: string; pass: boolean }[] = [];
const expected = batchTimes(from, to).length;
const readBatches = done.filter((d) => d.status === "ok" || d.status === "missing").length;
gates.push({ name: "GDELT complete: every 15-minute batch in the range read", found: `${readBatches} of ${expected}`, pass: readBatches === expected });
gates.push({ name: "1. at least 1,500 entry bars with an event (rolls dropped)", found: `${obs.length} bars from ${headlines.length} headlines`, pass: obs.length >= 1500 });

// volatility of a day = |close / open - 1| of its CL hourly bars, terciles over the whole history
const byDay = new Map<string, HBar[]>();
for (const b of allBars) byDay.set(dayOf(b.time * 1000), [...(byDay.get(dayOf(b.time * 1000)) ?? []), b]);
const dayVol = new Map([...byDay].map(([d, bs]) => [d, Math.abs(bs[bs.length - 1].close / bs[0].open - 1)] as const));
const sortedVol = [...dayVol.values()].sort((a, b) => a - b);
const cut = [sortedVol[Math.floor(sortedVol.length / 3)], sortedVol[Math.floor((2 * sortedVol.length) / 3)]];
const tercile = (v: number) => (v < cut[0] ? 0 : v < cut[1] ? 1 : 2);
const eventDays = [...new Set(obs.map((o) => dayOf(o.entry)))];
const perTercile = [0, 0, 0];
for (const d of eventDays) if (dayVol.has(d)) perTercile[tercile(dayVol.get(d)!)]++;
gates.push({ name: "2. at least 60 trading days with an event, at least 10 in each of two volatility terciles", found: `${eventDays.length} days; low/mid/high volatility days: ${perTercile.join("/")}`, pass: eventDays.length >= 60 && perTercile.filter((n) => n >= 10).length >= 2 });
gates.push({ name: "3. timestamps: GDELT batch time as the independent clock", found: "15-minute resolution, every event timed by GDELT", pass: true });

// hourly coverage on weekdays between the first and last event day
let weekdays = 0;
let covered = 0;
let worstGap = 0;
for (let t = from; t < to; t += DAY) {
  const dow = new Date(t).getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const bs = byDay.get(dayOf(t)) ?? [];
  if (bs.length === 0) continue; // an exchange holiday has no bars at all
  weekdays++;
  if (bs.length >= 20) covered++;
  for (let i = 1; i < bs.length; i++) worstGap = Math.max(worstGap, Math.round((bs[i].time - bs[i - 1].time) / 3600) - 1);
}
gates.push({ name: "4. hourly bars: 20 or more on 99% of trading weekdays, no gap over 3 hours inside a day", found: `${covered} of ${weekdays} days with 20+ bars; longest gap inside a day ${worstGap} hours`, pass: weekdays > 0 && covered / weekdays >= 0.99 && worstGap <= 3 });
const shift = lookAheadShift(headlines, bars);
gates.push({ name: "5. look-ahead: shifting events 1 hour later changes the entry bar of at least 50% of events", found: `${(shift * 100).toFixed(0)}% changed`, pass: shift >= 0.5 });

console.log(`Sentiment study data gate, ${dayOf(from)} to ${dayOf(to)}`);
for (const g of gates) console.log(`${g.pass ? "PASS" : "FAIL"}  ${g.name}\n        found: ${g.found}`);
const allPass = gates.every((g) => g.pass);
console.log(allPass ? "\nGate passed." : "\nGate FAILED: by the pre-registration the experiments do not run and no threshold is relaxed.");
if (!run) {
  console.log("(audit only: pass --run to run the experiments once every gate passes)");
  process.exit(allPass ? 0 : 1);
}
if (!allPass) process.exit(1);

// ---- the experiments (pre-registered; no tuning)
const half = Math.floor(obs.length / 2);
const cells: { horizon: string; data: Observation[]; ret: (o: Observation) => number | undefined }[] = [
  { horizon: "60 min", data: obs, ret: (o) => o.r60 },
  { horizon: "1 day", data: obs.filter((o) => o.r1d !== undefined), ret: (o) => o.r1d },
];
const results = cells.map((c) => {
  const tone = c.data.map((o) => o.tone);
  const ret = c.data.map((o) => c.ret(o)!);
  const r = icTest(tone, ret, 10_000, 1);
  const neg = shuffledControl(tone, ret);
  const a = icTest(tone.slice(0, half), ret.slice(0, half), 2000, 2).ic;
  const b = icTest(tone.slice(half), ret.slice(half), 2000, 3).ic;
  return { horizon: c.horizon, ...r, shuffledZ: neg.z, firstHalfIc: a, secondHalfIc: b };
});
const adj = holm(results.map((r) => r.p));
console.log("\nResults (crude lexicon tone, NYMEX CL, tone against the forward return of the entry bar):");
results.forEach((r, i) => console.log(`  ${r.horizon.padEnd(7)} n=${r.n}  IC=${r.ic.toFixed(4)}  p=${r.p.toFixed(4)}  Holm p=${adj[i].toFixed(4)}  z=${r.z.toFixed(2)}  shuffled-tone z=${r.shuffledZ.toFixed(2)}  IC by half ${r.firstHalfIc.toFixed(3)} / ${r.secondHalfIc.toFixed(3)}`));
console.log("\nThis is the information test only. By the pre-registration a positive verdict also needs the P&L after costs, the deflated Sharpe, the overfitting probability, the baseline ladder, the positive control and a second implementation: without all of them the result is INCONCLUSIVE, not a weak positive.");
