// EXPLORATORY, not pre-registered: a robustness check of the 1-day result of run-study.ts, written after that result was seen (trial counter 18 -> 19, see the
// log in PREREGISTRATION.md). The 1-day returns of adjacent entry bars overlap almost completely, so the permutation test treats about 1,800 observations as
// independent when there are about 120 trading days. This collapses to ONE observation per trading day: the day's mean tone against the same day's return and the
// NEXT trading day's return.
import { SQL } from "bun";
import { clExpiries, usHolidays } from "../../packages/shared/src/clExpiry";
import { crudeTone } from "../../packages/shared/src/crudeLexicon";
import { buildObservations, icTest, type HBar, type Headline } from "../../packages/shared/src/sentimentStudy";

const DAY = 86_400_000;
const from = Date.parse("2026-04-23T00:00:00Z");
const to = Date.parse("2026-10-23T00:00:00Z");
const sql = new SQL(process.env.DATABASE_URL!);
const headlines: Headline[] = ((await sql`SELECT seen_at, title FROM gdelt_headlines WHERE seen_at >= ${new Date(from).toISOString()} AND seen_at < ${new Date(to).toISOString()}`) as { seen_at: Date; title: string }[]).map((r) => ({ at: new Date(r.seen_at).getTime(), title: r.title }));
const bars: HBar[] = ((await sql`SELECT time, open, close FROM cl_hourly ORDER BY time`) as { time: Date; open: number; close: number }[]).map((b) => ({ time: new Date(b.time).getTime() / 1000, open: b.open, close: b.close })).filter((b) => b.time * 1000 < to + 3 * DAY);
await sql.close();

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const holidays = new Set<number>([...usHolidays(2025), ...usHolidays(2026), ...usHolidays(2027)]);
const excluded = new Set<string>();
for (const h of holidays) {
  let d = h + DAY;
  while ([0, 6].includes(new Date(d).getUTCDay()) || holidays.has(d)) d += DAY;
  excluded.add(dayOf(d));
}
const obs = buildObservations(headlines, bars, { tone: (t) => crudeTone(t).tone, expiries: clExpiries(from - 5 * DAY, to + 5 * DAY) }).filter((o) => !excluded.has(dayOf(o.entry)));

const byDay = new Map<string, HBar[]>();
for (const b of bars) byDay.set(dayOf(b.time * 1000), [...(byDay.get(dayOf(b.time * 1000)) ?? []), b]);
const dayRet = (d: string) => { const bs = byDay.get(d); return bs && bs.length >= 15 ? bs[bs.length - 1].close / bs[0].open - 1 : undefined; };
const toneByDay = new Map<string, number[]>();
for (const o of obs) toneByDay.set(dayOf(o.entry), [...(toneByDay.get(dayOf(o.entry)) ?? []), o.tone]);
const days = [...toneByDay.keys()].sort();
const rows = days.flatMap((d, i) => {
  const next = days.find((x, j) => j > i && byDay.has(x));
  const tone = toneByDay.get(d)!.reduce((a, x) => a + x, 0) / toneByDay.get(d)!.length;
  return [{ d, tone, same: dayRet(d), next: next ? dayRet(next) : undefined }];
});
const run = (name: string, key: "same" | "next") => {
  const r = rows.filter((x) => x[key] !== undefined);
  const res = icTest(r.map((x) => x.tone), r.map((x) => x[key]!), 10_000, 11);
  console.log(`  ${name.padEnd(34)} n=${res.n}  IC=${res.ic.toFixed(4)}  p(one-sided)=${res.p.toFixed(4)}  z=${res.z.toFixed(2)}`);
};
console.log("EXPLORATORY daily check (one observation per trading day):");
run("day tone vs the same day return", "same");
run("day tone vs the NEXT day return", "next");
