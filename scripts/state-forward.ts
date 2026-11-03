// Did the market-state leans ever pay? Runs the SAME rules the Market state panel uses (shared marketState.ts) over the recorded one-minute candles and the
// recorded book, and measures what price did over the next 15 and 30 minutes. Read-only.
//   bun run --env-file=.env scripts/state-forward.ts [--underlying=CRUDEOILM] [--days=90]
//
// PRE-REGISTERED (written before the first run; do not change after looking):
//   * Readings tested: Against VWAP, Day range, Last 30 min (bar rules), and Book (top levels) where the book was recorded. Option, premium and calendar
//     readings are context or need history we do not hold, and are not tested here.
//   * A sample is taken every `h` minutes (h = 15 and 30), so forward windows never overlap. Forward move = close h minutes later against the close now,
//     within the same trading day, in basis points. A lean "up" is right when the move is positive, "down" when negative.
//   * The days are split in time order: the first two thirds are DEVELOPMENT, the last third is HOLDOUT. The holdout is read once, here, with no tuning.
//   * A lean SURVIVES only if, on the holdout, its hit rate is above 50% with z >= 2.0 (normal approximation to the binomial) with at least 30 samples,
//     AND the development hit rate is also above 50%. With up to 16 lean/horizon combinations tested, one or two clearing 2.0 by luck is expected: a survivor
//     is a candidate for a longer test, not a signal. Costs are NOT deducted.
//   * The thresholds are the panel's (STATE_RULES), taken as they stand. Nothing is optimised.
// Differences from the live panel, stated: the VWAP is the candles' own volume-weighted hlc3 per IST day (the live panel uses the exchange's ATP); each
// day uses that day's most-traded contract, so a price level can jump at a roll (the day boundary only).
import { SQL } from "bun";
import { barReadings, bookImbalance, resampleBars, STATE_RULES, type Bar } from "../packages/shared/src";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const underlying = arg("underlying") ?? "CRUDEOILM";
const days = Number(arg("days") ?? 90);
const IST = 19_800;
const dayOf = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);

const sql = new SQL(process.env.DATABASE_URL!);
const keys = ((await sql`SELECT key FROM option_contracts WHERE side = 'FUT' AND underlying = ${underlying}`) as { key: string }[]).map((r) => r.key);
const since = new Date(Date.now() - days * 86_400_000);
const rows = keys.length ? ((await sql`SELECT key, extract(epoch FROM time)::int AS t, open, high, low, close, volume FROM option_candles WHERE key IN ${sql(keys)} AND time >= ${since} ORDER BY time`) as { key: string; t: number; open: number; high: number; low: number; close: number; volume: number }[]) : [];
if (!rows.length) {
  console.log(`No one-minute candles for ${underlying}.`);
  process.exit(0);
}
const vol = new Map<string, Map<string, number>>();
for (const r of rows) {
  const d = dayOf(r.t);
  const m = vol.get(d) ?? new Map<string, number>();
  m.set(r.key, (m.get(r.key) ?? 0) + Number(r.volume));
  vol.set(d, m);
}
const pick = new Map([...vol].map(([d, m]) => [d, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]]));
const oneMin: Bar[] = rows.filter((r) => pick.get(dayOf(r.t)) === r.key).map((r) => ({ time: r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
const bars = resampleBars(oneMin, 300, IST); // 5-minute bars on the IST grid
console.log(`${underlying}: ${bars.length} five-minute bars over ${vol.size} days (${[...vol.keys()][0]} to ${[...vol.keys()].at(-1)})`);

// the recorded book at a moment: the newest row at or before it, no older than a minute
type BookRow = { t: number; bid_qty: number | null; ask_qty: number | null; depth: { bidQ?: number; askQ?: number }[] | null };
const bookRows = (await sql`SELECT extract(epoch FROM time)::int AS t, bid_qty, ask_qty, depth FROM feed_quotes WHERE key = ${"MCX:" + underlying} AND time >= ${since} AND (bid_qty IS NOT NULL OR depth IS NOT NULL) ORDER BY time`.catch(() => [])) as BookRow[];
let bk = 0;
const bookAt = (t: number): number | undefined => {
  while (bk + 1 < bookRows.length && bookRows[bk + 1].t <= t) bk++;
  const r = bookRows[bk];
  if (!r || r.t > t || t - r.t > 60) return undefined;
  return bookImbalance({ bidQty: r.bid_qty ?? undefined, askQty: r.ask_qty ?? undefined, depth: r.depth ?? undefined });
};

interface Sample {
  id: string;
  lean: "up" | "down";
  h: number;
  day: string;
  bps: number;
}
const samples: Sample[] = [];
const allMoves: { h: number; day: string; bps: number }[] = [];
const perDay = new Map<string, number[]>();
bars.forEach((b, i) => perDay.set(dayOf(b.time), [...(perDay.get(dayOf(b.time)) ?? []), i]));
for (const h of [15, 30]) {
  const step = h / 5;
  bk = 0;
  for (const [day, idx] of perDay) {
    let cumPV = 0;
    let cumV = 0;
    let hi = -Infinity;
    let lo = Infinity;
    idx.forEach((i, k) => {
      const b = bars[i];
      cumPV += ((b.high + b.low + b.close) / 3) * (b.volume || 0);
      cumV += b.volume || 0;
      hi = Math.max(hi, b.high);
      lo = Math.min(lo, b.low);
      const j = idx[k + step];
      if (k % step !== 0 || j === undefined) return; // non-overlapping, same day only
      const bps = ((bars[j].close - b.close) / b.close) * 10_000;
      allMoves.push({ h, day, bps });
      const hist = bars.slice(Math.max(0, i - 400), i + 1);
      const rs = barReadings(hist, b.close, { atp: cumV > 0 ? cumPV / cumV : undefined, dayHigh: hi, dayLow: lo });
      for (const r of rs) if ((r.id === "vwap" || r.id === "range" || r.id === "momentum") && (r.lean === "up" || r.lean === "down")) samples.push({ id: r.id, lean: r.lean, h, day, bps });
      const imb = bookAt(b.time + 300); // the book at the bar's close
      if (imb !== undefined && Math.abs(imb) >= STATE_RULES.bookImbalance) samples.push({ id: "book", lean: imb > 0 ? "up" : "down", h, day, bps });
    });
  }
}

const dates = [...perDay.keys()].sort();
const cut = dates[Math.ceil((dates.length * 2) / 3) - 1];
const stat = (xs: Sample[]) => {
  const n = xs.length;
  const nz = xs.filter((s) => s.bps !== 0);
  const hits = nz.filter((s) => (s.lean === "up" ? s.bps > 0 : s.bps < 0)).length;
  const z = nz.length ? (hits - nz.length / 2) / Math.sqrt(nz.length / 4) : 0;
  const signed = n ? xs.reduce((a, s) => a + (s.lean === "up" ? s.bps : -s.bps), 0) / n : 0;
  return { n, hit: nz.length ? hits / nz.length : NaN, z, signed };
};
const f = (s: ReturnType<typeof stat>) => (s.n ? `n ${String(s.n).padStart(4)}  hit ${(s.hit * 100).toFixed(1).padStart(5)}%  z ${s.z.toFixed(2).padStart(5)}  avg ${s.signed.toFixed(1).padStart(6)} bp` : "n    0");
const drift = (h: number) => {
  const m = allMoves.filter((x) => x.h === h);
  return `${m.length} windows, average move ${(m.reduce((a, x) => a + x.bps, 0) / (m.length || 1)).toFixed(1)} bp, up ${((m.filter((x) => x.bps > 0).length / (m.length || 1)) * 100).toFixed(0)}% of the time`;
};
console.log(`Development: ${dates[0]} to ${cut}. Holdout: after ${cut} to ${dates.at(-1)}. Book recorded: ${bookRows.length ? `${bookRows.length} rows` : "none"}.\n`);
let survivors = 0;
let tested = 0;
for (const h of [15, 30]) {
  console.log(`--- ${h} minutes ahead (baseline: ${drift(h)}) ---`);
  for (const id of ["vwap", "range", "momentum", "book"]) {
    for (const lean of ["up", "down"] as const) {
      const xs = samples.filter((s) => s.id === id && s.lean === lean && s.h === h);
      if (!xs.length) continue;
      const dev = stat(xs.filter((s) => s.day <= cut));
      const out = stat(xs.filter((s) => s.day > cut));
      tested++;
      const ok = dev.hit > 0.5 && out.hit > 0.5 && out.z >= 2 && out.n >= 30;
      if (ok) survivors++;
      console.log(`${id.padEnd(9)} ${lean.padEnd(5)} dev ${f(dev)} | holdout ${f(out)}${ok ? "  <- SURVIVES" : ""}`);
    }
  }
}
const luck = Math.ceil(tested * 0.023);
console.log(`\n${survivors} of ${tested} lean/horizon combinations survive. About ${luck} would clear z >= 2.0 on the holdout by luck alone, so ${survivors <= luck ? "this is consistent with no edge." : "look at the survivors in a longer test, as candidates and not signals."} Costs are not deducted.`);
await sql.close();
