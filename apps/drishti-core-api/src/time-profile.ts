import type { SQL } from "bun";
import { nyClock, PROFILE_WINDOWS, summarizeWindows, zoneDays, type ProfileBar, type ProfileUnderlying, type TimeProfile, type WindowProfile } from "@drishti/shared";

/**
 * The time-of-day profile of one MCX underlying from the one-minute candles we hold (`option_candles`, side FUT): per day the contract with the most
 * volume that New York day, then per named window the high, low, range, average price and activity, with the average spread from the recorded feed.
 * Descriptive only: it says when the market is busy, not which way it goes.
 */
export async function timeProfile(sql: SQL, underlying: ProfileUnderlying, days: number, recent = 3): Promise<TimeProfile> {
  const keys = ((await sql`SELECT key FROM option_contracts WHERE side = 'FUT' AND underlying = ${underlying}`) as { key: string }[]).map((r) => r.key);
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = keys.length
    ? ((await sql`SELECT key, extract(epoch FROM time)::int AS t, open, high, low, close, volume FROM option_candles WHERE key IN ${sql(keys)} AND time >= ${since} ORDER BY time`) as { key: string; t: number; open: number; high: number; low: number; close: number; volume: number }[])
    : [];

  // one contract per New York day: the one that traded most that day
  const vol = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const d = nyClock(r.t).date;
    const m = vol.get(d) ?? new Map<string, number>();
    m.set(r.key, (m.get(r.key) ?? 0) + Number(r.volume));
    vol.set(d, m);
  }
  const pick = new Map([...vol].map(([d, m]) => [d, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]]));
  const bars: ProfileBar[] = rows.filter((r) => pick.get(nyClock(r.t).date) === r.key).map((r) => ({ time: r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));

  const all = zoneDays(bars);
  const summary = summarizeWindows(all, bars);

  // spreads: half-hour buckets of New York time from the recorded feed
  const symbol = `MCX:${underlying}`;
  const sp = (await sql`
    SELECT (floor((extract(hour FROM time AT TIME ZONE 'America/New_York') * 60 + extract(minute FROM time AT TIME ZONE 'America/New_York')) / 30) * 30)::int AS m,
           count(*)::int AS n, avg((ask - bid) / ((ask + bid) / 2)) * 100 AS pct
    FROM feed_quotes WHERE key = ${symbol} AND bid > 0 AND ask >= bid AND time >= ${since} GROUP BY 1`.catch(() => [])) as { m: number; n: number; pct: number }[];
  const spreadDays = ((await sql`SELECT count(DISTINCT (time AT TIME ZONE 'America/New_York')::date)::int AS n FROM feed_quotes WHERE key = ${symbol} AND bid > 0 AND time >= ${since}`.catch(() => [{ n: 0 }])) as { n: number }[])[0]?.n ?? 0;

  const windows: WindowProfile[] = summary.map((w) => {
    const def = PROFILE_WINDOWS.find((x) => x.id === w.window)!;
    const inside = sp.filter((b) => b.m >= def.from && b.m < def.to);
    const n = inside.reduce((a, b) => a + b.n, 0);
    return { ...w, spreadRows: n, spreadPct: n ? inside.reduce((a, b) => a + b.pct * b.n, 0) / n : undefined };
  });

  const dates = [...new Set(all.map((d) => d.day))];
  const last = new Set(dates.slice(-recent));
  return { underlying, from: dates[0], to: dates[dates.length - 1], days: dates.length, spreadDays, windows, recent: all.filter((d) => last.has(d.day)) };
}
