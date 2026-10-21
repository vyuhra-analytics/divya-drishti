// Price agreement between feeds: when two sources both quote the same contract live, they should agree to within a few ticks.
// A widening gap means one feed is stale, mis-mapped (wrong contract month) or broken. Pure and tested.
import { instrument } from "./index";

/** What the stream last heard from one source for one symbol. */
export interface SourcePrice {
  price: number;
  /** when the stream received it, epoch ms */
  at: number;
  /** how far behind the exchange this source runs, seconds */
  delayedBy?: number;
}

export type SourcePrices = Record<string, SourcePrice>;

/** Two live feeds further apart than this share of price are flagged. MCX crude vs gas ticks are 0.01% to 0.1% of price, so 0.15% is "several ticks". */
export const DRIFT_FLAG_PCT = 0.15;
const FRESH_MS = 60_000;
const MAX_DELAY_DIFF_S = 120; // a 10-minute-delayed feed is not comparable with a live one

export interface Agreement {
  symbol: string;
  /** sources heard from in the last minute and comparable with each other */
  sources: { source: string; price: number; ageMs: number }[];
  /** widest gap between any two of them, in price points, percent of price and instrument ticks */
  gap?: { points: number; pct: number; ticks: number; between: [string, string] };
  /** true when the gap is over DRIFT_FLAG_PCT */
  drifting: boolean;
}

/** Compare the fresh, comparable sources of one symbol. Fewer than two such sources is no comparison, not a pass. */
export function agreement(symbol: string, prices: SourcePrices, now: number, thresholdPct = DRIFT_FLAG_PCT): Agreement {
  const fresh = Object.entries(prices).filter(([, p]) => now - p.at <= FRESH_MS && Number.isFinite(p.price) && p.price > 0);
  // keep the group that shares the most common delay, so a live feed is only compared with live feeds
  const delays = new Map<number, number>();
  for (const [, p] of fresh) delays.set(Math.round((p.delayedBy ?? 0) / MAX_DELAY_DIFF_S), (delays.get(Math.round((p.delayedBy ?? 0) / MAX_DELAY_DIFF_S)) ?? 0) + 1);
  const bucket = [...delays.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const comparable = fresh.filter(([, p]) => Math.round((p.delayedBy ?? 0) / MAX_DELAY_DIFF_S) === bucket);
  const sources = comparable.map(([source, p]) => ({ source, price: p.price, ageMs: now - p.at }));
  if (sources.length < 2) return { symbol, sources, drifting: false };
  const lo = sources.reduce((a, b) => (b.price < a.price ? b : a));
  const hi = sources.reduce((a, b) => (b.price > a.price ? b : a));
  const points = hi.price - lo.price;
  const tick = 10 ** -(instrument(symbol)?.decimals ?? 2);
  const pct = (points / lo.price) * 100;
  return { symbol, sources, gap: { points, pct, ticks: Math.round(points / tick), between: [lo.source, hi.source] }, drifting: pct > thresholdPct };
}
