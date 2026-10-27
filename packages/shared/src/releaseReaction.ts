// How the market reacted to a scheduled release (an EIA report at 10:30 New York): from one-minute candles, the price move at fixed minutes after
// it, the largest swing and how fast it came, and the volume of the first minutes against the hour before; and, from our own recording of the feed,
// how the spread, the estimated delta and the book behaved. Pure, so the arithmetic is tested; it states what happened and never why.
import { estimateFlow, type FlowRow } from "./orderFlow";

const MIN = 60;

export interface ReactionBar {
  /** the candle's open, epoch seconds */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Move {
  /** minutes after the release */
  minutes: number;
  price: number;
  change: number;
  pct: number;
}

export interface Reaction {
  symbol: string;
  /** the release, epoch ms */
  releaseAt: number;
  /** the close of the last candle that ended at or before the release: the price the market had just before it */
  basePrice: number;
  moves: Move[];
  /** the widest excursion from the base in the first 15 minutes, up and down, and which came first */
  maxUp15: number;
  maxDown15: number;
  firstSwing15: "up" | "down" | "none";
  /** the high and the low of the first hour (or as much of it as there is) against the base */
  high60: number;
  low60: number;
  /** volume of the first five minutes, the average five-minute volume of the hour before, and their ratio (absent without volume before) */
  volumeFirst5: number;
  volumeBefore5: number | undefined;
  volumeRatio: number | undefined;
  /** how many minutes of candles after the release the figures rest on (60 when complete) */
  minutesCovered: number;
}

const MOVE_MINUTES = [1, 5, 15, 30, 60];
const r = (v: number, d = 2) => Number(v.toFixed(d));

/**
 * `bars` are one-minute candles, oldest first. Returns undefined when there is no candle before the release or none from it on (it has not happened,
 * or the market was closed), so a caller never reports a reaction it cannot see.
 */
export function releaseReaction(symbol: string, bars: readonly ReactionBar[], releaseAt: number): Reaction | undefined {
  const t = Math.floor(releaseAt / 1000 / MIN) * MIN;
  const before = bars.filter((b) => b.time + MIN <= t);
  const after = bars.filter((b) => b.time >= t && b.time < t + 60 * MIN);
  const base = before[before.length - 1];
  if (!base || !after.length) return undefined;
  const basePrice = base.close;

  const moves: Move[] = [];
  for (const k of MOVE_MINUTES) {
    const bar = after.find((b) => b.time === t + (k - 1) * MIN); // the candle that ends k minutes after the release
    if (!bar) continue;
    moves.push({ minutes: k, price: bar.close, change: r(bar.close - basePrice, 4), pct: r(((bar.close - basePrice) / basePrice) * 100) });
  }

  const first15 = after.filter((b) => b.time < t + 15 * MIN);
  let maxUp = 0;
  let maxDown = 0;
  let firstSwing: Reaction["firstSwing15"] = "none";
  let upAt = Infinity;
  let downAt = Infinity;
  for (const b of first15) {
    if (b.high - basePrice > maxUp) {
      maxUp = b.high - basePrice;
      upAt = b.time;
    }
    if (basePrice - b.low > maxDown) {
      maxDown = basePrice - b.low;
      downAt = b.time;
    }
  }
  if (maxUp > 0 || maxDown > 0) firstSwing = upAt < downAt ? "up" : downAt < upAt ? "down" : maxUp >= maxDown ? "up" : "down";

  const hour = Math.max(...after.map((b) => b.high));
  const hourLow = Math.min(...after.map((b) => b.low));
  const prior = bars.filter((b) => b.time >= t - 60 * MIN && b.time + MIN <= t);
  const priorTotal = prior.reduce((s, b) => s + b.volume, 0);
  const volumeFirst5 = after.filter((b) => b.time < t + 5 * MIN).reduce((s, b) => s + b.volume, 0);
  const volumeBefore5 = prior.length >= 30 && priorTotal > 0 ? r((priorTotal / prior.length) * 5, 1) : undefined;

  return {
    symbol,
    releaseAt,
    basePrice,
    moves,
    maxUp15: r(maxUp, 4),
    maxDown15: r(maxDown, 4),
    firstSwing15: firstSwing,
    high60: r(hour - basePrice, 4),
    low60: r(hourLow - basePrice, 4),
    volumeFirst5,
    volumeBefore5,
    volumeRatio: volumeBefore5 ? r(volumeFirst5 / volumeBefore5, 1) : undefined,
    minutesCovered: Math.min(60, Math.round((after[after.length - 1].time + MIN - t) / MIN)),
  };
}

export interface Microstructure {
  /** average best ask minus best bid in the five minutes before, and in the five minutes after, the release; and the widest one-minute average after it */
  spreadBefore?: number;
  spreadAfter?: number;
  spreadWidest?: number;
  /** ESTIMATED delta (buy minus sell volume, see orderFlow.ts) in the first five and fifteen minutes, and the average book imbalance (-1 to 1) in the first five */
  deltaFirst5: number;
  deltaFirst15: number;
  imbalanceFirst5?: number;
  /** snapshots per minute before and after: how busy the feed was */
  msgsPerMinBefore?: number;
  msgsPerMinAfter?: number;
}

/**
 * From the recorded feed rows of one contract around the release. Undefined when the feed was not recorded after it. Everything about delta and
 * book is an estimate (Upstox has no trade tape); the spread and message counts are as recorded.
 */
export function releaseMicrostructure(rows: readonly FlowRow[], releaseAt: number): Microstructure | undefined {
  const inRange = (from: number, to: number) => rows.filter((x) => x.time >= from && x.time < to);
  const before = inRange(releaseAt - 5 * MIN * 1000, releaseAt);
  const after = inRange(releaseAt, releaseAt + 5 * MIN * 1000);
  if (after.length < 5) return undefined;
  const spread = (xs: readonly FlowRow[]) => {
    const s = xs.flatMap((x) => (x.bid && x.ask && x.ask >= x.bid ? [x.ask - x.bid] : []));
    return s.length ? r(s.reduce((a, b) => a + b, 0) / s.length, 3) : undefined;
  };
  const perMinute = new Map<number, FlowRow[]>();
  for (const x of after) perMinute.set(Math.floor(x.time / 60_000), [...(perMinute.get(Math.floor(x.time / 60_000)) ?? []), x]);
  const widest = Math.max(...[...perMinute.values()].map((xs) => spread(xs) ?? 0));
  const buckets = estimateFlow(rows.filter((x) => x.time < releaseAt + 15 * MIN * 1000), 60, 0);
  const T = Math.floor(releaseAt / 1000 / MIN) * MIN;
  const sumDelta = (minutes: number) => r(buckets.filter((b) => b.time >= T && b.time < T + minutes * MIN).reduce((s, b) => s + b.delta, 0), 0);
  const imb = buckets.filter((b) => b.time >= T && b.time < T + 5 * MIN && b.imbalance !== undefined);
  return {
    spreadBefore: spread(before),
    spreadAfter: spread(after),
    spreadWidest: widest > 0 ? r(widest, 3) : undefined,
    deltaFirst5: sumDelta(5),
    deltaFirst15: sumDelta(15),
    imbalanceFirst5: imb.length ? r(imb.reduce((s, b) => s + (b.imbalance ?? 0), 0) / imb.length, 2) : undefined,
    msgsPerMinBefore: before.length ? r(before.length / 5, 0) : undefined,
    msgsPerMinAfter: r(after.length / 5, 0),
  };
}
