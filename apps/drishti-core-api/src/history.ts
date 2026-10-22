import { userAgentFor } from "@drishti/shared";
import { mergeBars, normalizeBars, parseUpstoxCandles, validateBars, parseYahooCandles, TIMEFRAMES, type Bar, type Instrument, type MasterRow, type Timeframe } from "@drishti/shared";
import type { RedisClient } from "bun";

// Provider history for charts. Yahoo for NYMEX (no login, 10 min delayed), Upstox for MCX (needs today's token).

const UA = { "User-Agent": userAgentFor("query1.finance.yahoo.com") };
const YAHOO: Record<Timeframe, { interval: string; range: string }> = {
  "1m": { interval: "1m", range: "5d" },
  "5m": { interval: "5m", range: "1mo" },
  "15m": { interval: "15m", range: "1mo" },
  "1h": { interval: "60m", range: "6mo" },
  "1d": { interval: "1d", range: "5y" },
};
// Upstox unit/interval and how far back to ask (API limits: ≤15m → 1 month, hours → 1 quarter, days → 1 decade)
const UPSTOX: Record<Timeframe, { unit: string; interval: number; days: number }> = {
  "1m": { unit: "minutes", interval: 1, days: 7 },
  "5m": { unit: "minutes", interval: 5, days: 30 },
  "15m": { unit: "minutes", interval: 15, days: 30 },
  "1h": { unit: "hours", interval: 1, days: 90 },
  "1d": { unit: "days", interval: 1, days: 730 },
};

/** Drop bars that cannot be real (high under the low, a zero price...) and say so: bad provider data is never stored or drawn. */
function clean(label: string, bars: Bar[]): Bar[] {
  const { bars: kept, dropped } = validateBars(bars);
  if (dropped.length) console.warn(`history ${label}: dropped ${dropped.length} impossible bar(s), e.g. ${dropped[0].reason} at ${new Date(dropped[0].time * 1000).toISOString()}`);
  return kept;
}

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

export async function yahooHistory(inst: Instrument, tf: Timeframe): Promise<Bar[]> {
  const { interval, range } = YAHOO[tf];
  const json = await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(inst.yahoo!)}?interval=${interval}&range=${range}`,
    UA,
  );
  return clean(`${inst.symbol} ${tf} (yahoo)`, normalizeBars(parseYahooCandles(json), TIMEFRAMES[tf], inst.timeZone, inst.decimals));
}

const STREAM = `http://127.0.0.1:${process.env.STREAM_PORT ?? 3002}`;

/**
 * Traded MCX contracts: from Redis (published by the stream every minute), or straight from the stream's /fronts
 * when Redis isn't running, so MCX history works without Docker/Redis.
 */
export async function loadFronts(redis: RedisClient): Promise<Record<string, MasterRow> | null> {
  const cached = await redis.get("fronts").catch(() => null);
  if (cached) return JSON.parse(cached);
  const fromStream = await fetch(`${STREAM}/fronts`, { signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return fromStream && Object.keys(fromStream).length ? fromStream : null;
}

const ymd = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10); // IST date

/** null when Upstox can't be used (no token, or front months unknown: stream not running yet). */
export async function upstoxHistory(inst: Instrument, tf: Timeframe, redis: RedisClient): Promise<Bar[] | null> {
  // Redis is optional: a failed read just means no login token / no cached fronts
  const [login, fronts] = await Promise.all([redis.get("upstox:token").catch(() => null), loadFronts(redis)]);
  const token = login || process.env.UPSTOX_ACCESS_TOKEN?.trim(); // today's login first, else the .env token
  const front: MasterRow | undefined = fronts?.[inst.upstox!];
  if (!token || !front) return null;
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
  const { unit, interval, days } = UPSTOX[tf];
  const key = encodeURIComponent(front.instrument_key);
  const now = Date.now();
  const [past, today] = await Promise.all([
    getJson(`https://api.upstox.com/v3/historical-candle/${key}/${unit}/${interval}/${ymd(now)}/${ymd(now - days * 86_400_000)}`, headers),
    getJson(`https://api.upstox.com/v3/historical-candle/intraday/${key}/${unit}/${interval}`, headers).catch(() => null),
  ]);
  // ponytail: front-month history only; after a roll the chart starts at the new contract's listing. Stitch expired contracts if continuity matters.
  return clean(`${inst.symbol} ${tf} (upstox)`, normalizeBars(mergeBars(parseUpstoxCandles(past), parseUpstoxCandles(today)), TIMEFRAMES[tf], inst.timeZone, inst.decimals));
}
