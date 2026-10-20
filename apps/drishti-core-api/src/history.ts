import { mergeBars, normalizeBars, parseUpstoxCandles, parseYahooCandles, TIMEFRAMES, type Bar, type Instrument, type MasterRow, type Timeframe } from "@drishti/shared";
import type { RedisClient } from "bun";

// Provider history for charts. Yahoo for NYMEX (no login, 10 min delayed), Upstox for MCX (needs today's token).

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0 Safari/537.36" };
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
  return normalizeBars(parseYahooCandles(json), TIMEFRAMES[tf], inst.timeZone, inst.decimals);
}

const ymd = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10); // IST date

/** null when Upstox can't be used (no login today, or the stream hasn't published front months yet). */
export async function upstoxHistory(inst: Instrument, tf: Timeframe, redis: RedisClient): Promise<Bar[] | null> {
  const [token, frontsJson] = await Promise.all([redis.get("upstox:token"), redis.get("fronts")]);
  const front: MasterRow | undefined = frontsJson ? JSON.parse(frontsJson)[inst.upstox!] : undefined;
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
  return normalizeBars(mergeBars(parseUpstoxCandles(past), parseUpstoxCandles(today)), TIMEFRAMES[tf], inst.timeZone, inst.decimals);
}
