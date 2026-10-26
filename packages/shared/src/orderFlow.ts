// ESTIMATED order flow from our own recording of the Upstox feed (`feed_quotes`). Upstox gives no trade tape and no aggressor side: it sends a
// snapshot about once a second per contract, each merging however many trades happened since the last. So the buy/sell split here is an estimate:
// every volume increase between two snapshots is given to one side by comparing the new price with the quote that stood before it (Lee-Ready),
// then summed per candle. Right on average, wrong on busy seconds, least accurate exactly when trading is fastest. Never an exact tape.
import { bucketStart } from "./index";

export interface FlowRow {
  /** when we received the snapshot, epoch ms */
  time: number;
  /** last traded price; absent or 0 for a contract nobody has traded */
  price?: number | null;
  /** cumulative day volume */
  volume?: number | null;
  bid?: number | null;
  ask?: number | null;
  bidQty?: number | null;
  askQty?: number | null;
  /** up to five levels, best first */
  depth?: { bidP?: number; bidQ?: number; askP?: number; askQ?: number }[] | null;
}

export interface FlowBucket {
  /** the candle's open, epoch seconds (same grid as the candles) */
  time: number;
  /** volume given to the buyer / seller, and volume that could not be given to either (price on the middle with no tick to go by) */
  buy: number;
  sell: number;
  unclassified: number;
  /** everything that traded in the bucket, as the cumulative volume grew (matches the candle's volume to within what we missed) */
  volume: number;
  /** buy - sell */
  delta: number;
  /** running delta, restarting at each IST day */
  cumDelta: number;
  /** resting size: (bid - ask) / (bid + ask) over the book levels, averaged over the bucket's snapshots, -1 to 1; undefined without a book */
  imbalance?: number;
  /** average best ask - best bid */
  spread?: number;
  /** snapshots in the bucket: how well the bucket is sampled */
  msgs: number;
}

type Side = "buy" | "sell";

/** Which side hit: at or through the quote that stood before the trade is decisive, otherwise the middle of it, otherwise the tick rule. */
function classify(price: number, prev: FlowRow, lastSide: Side | undefined): Side | undefined {
  const bid = prev.bid && prev.bid > 0 ? prev.bid : undefined;
  const ask = prev.ask && prev.ask > 0 ? prev.ask : undefined;
  if (ask !== undefined && price >= ask) return "buy";
  if (bid !== undefined && price <= bid) return "sell";
  if (bid !== undefined && ask !== undefined) {
    const mid = (bid + ask) / 2;
    if (price > mid) return "buy";
    if (price < mid) return "sell";
  }
  if (prev.price && prev.price > 0) {
    if (price > prev.price) return "buy";
    if (price < prev.price) return "sell";
  }
  return lastSide; // same price as before: the same pressure as the last trade that had a direction
}

/** (bid - ask) / (bid + ask) of the resting size, from the levels when there are any, else from the best level. */
function imbalanceOf(r: FlowRow): number | undefined {
  let bid = 0;
  let ask = 0;
  if (r.depth?.length) {
    for (const l of r.depth) {
      bid += l.bidQ ?? 0;
      ask += l.askQ ?? 0;
    }
  } else {
    bid = r.bidQty ?? 0;
    ask = r.askQty ?? 0;
  }
  return bid + ask > 0 ? (bid - ask) / (bid + ask) : undefined;
}

/**
 * `rows` of ONE contract, oldest first. Buckets are on the candle grid for `tfSeconds` in the exchange's time (`offsetSec`, IST = 19,800).
 * A volume decrease (the day's counter restarting) is ignored; the first row has nothing to compare with.
 */
export function estimateFlow(rows: readonly FlowRow[], tfSeconds: number, offsetSec = 0): FlowBucket[] {
  const sums = new Map<number, { b: FlowBucket; imb: number; imbN: number; spr: number; sprN: number }>();
  const slot = (t: number) => {
    let s = sums.get(t);
    if (!s) sums.set(t, (s = { b: { time: t, buy: 0, sell: 0, unclassified: 0, volume: 0, delta: 0, cumDelta: 0, msgs: 0 }, imb: 0, imbN: 0, spr: 0, sprN: 0 }));
    return s;
  };
  let prev: FlowRow | undefined;
  let lastSide: Side | undefined;
  for (const r of rows) {
    const s = slot(bucketStart(r.time / 1000, tfSeconds, offsetSec));
    s.b.msgs++;
    const imb = imbalanceOf(r);
    if (imb !== undefined) {
      s.imb += imb;
      s.imbN++;
    }
    if (r.bid && r.ask && r.bid > 0 && r.ask >= r.bid) {
      s.spr += r.ask - r.bid;
      s.sprN++;
    }
    if (prev && r.volume != null && prev.volume != null) {
      const dv = r.volume - prev.volume;
      if (dv > 0) {
        s.b.volume += dv;
        const side = r.price && r.price > 0 ? classify(r.price, prev, lastSide) : undefined;
        if (side === "buy") s.b.buy += dv;
        else if (side === "sell") s.b.sell += dv;
        else s.b.unclassified += dv;
        if (side) lastSide = side;
      }
    }
    if (r.volume != null) prev = r;
  }
  const out = [...sums.values()].sort((a, b) => a.b.time - b.b.time);
  let cum = 0;
  let day = NaN;
  for (const s of out) {
    const d = Math.floor((s.b.time + offsetSec) / 86_400);
    if (d !== day) {
      cum = 0;
      day = d;
    }
    s.b.delta = s.b.buy - s.b.sell;
    cum += s.b.delta;
    s.b.cumDelta = cum;
    if (s.imbN) s.b.imbalance = s.imb / s.imbN;
    if (s.sprN) s.b.spread = s.spr / s.sprN;
  }
  return out.map((s) => s.b);
}
