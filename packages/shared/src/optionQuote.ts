// A live option quote from Upstox's Market Data Feed V3 (mode `full`): last price, five levels of depth, open interest, volume, IV and greeks, per
// instrument key. Pure, so the decoding and the checks are tested against a real decoded message; the stream and the web app share the type.

export interface DepthLevel {
  bidP?: number;
  bidQ?: number;
  askP?: number;
  askQ?: number;
}

export interface OptionQuote {
  /** Upstox instrument key, e.g. MCX_FO|582939 */
  key: string;
  /** last traded price: the premium */
  price: number;
  /** exchange trade time, epoch ms (the feed's own clock, second resolution) */
  time: number;
  /** when our stream received it, epoch ms: the difference with `time` is the lag we add */
  recvAt: number;
  prevClose?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  /** up to five levels, best first; a zero price or quantity ("no order on that side") is left out */
  depth?: DepthLevel[];
  oi?: number;
  volume?: number;
  /** average traded price */
  atp?: number;
  /** quantity of the last trade */
  ltq?: number;
  /** total pending buy / sell quantity in the order book */
  totalBuyQty?: number;
  totalSellQty?: number;
  /** implied volatility in percent (the feed sends a fraction) */
  iv?: number;
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
  rho?: number;
}

/** An Upstox MCX derivative instrument key: the only keys the stream will subscribe to for a client. */
export const OPTION_KEY = /^MCX_FO\|\d{3,8}$/;

const num = (v: unknown): number | undefined => {
  const n = v === undefined || v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const pos = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};

/**
 * One decoded feed entry (`feeds[key]` of a FeedResponse, protobuf already turned into a plain object) → a quote, or undefined when
 * it has no usable last price. Greeks and IV exist only for options; zero depth entries mean no order and are dropped.
 */
export function parseOptionFeed(key: string, feed: any, recvAt: number, allowUntraded = false): OptionQuote | undefined {
  const ff = feed?.fullFeed?.marketFF;
  const first = feed?.firstLevelWithGreeks; // the `option_greeks` mode's shape, in case the mode is ever changed
  const ltpc = ff?.ltpc ?? feed?.ltpc ?? first?.ltpc;
  // a contract nobody has traded still has a book (bids, asks, circuit-bound quotes): the recorder keeps those with price 0, the screens do not
  const price = pos(ltpc?.ltp) ?? (allowUntraded ? 0 : undefined);
  if (price === undefined) return undefined;
  const levels: DepthLevel[] = (ff?.marketLevel?.bidAskQuote ?? [])
    .map((l: any) => ({ bidP: pos(l?.bidP), bidQ: pos(l?.bidQ), askP: pos(l?.askP), askQ: pos(l?.askQ) }))
    .filter((l: DepthLevel) => l.bidP !== undefined || l.askP !== undefined)
    .slice(0, 5);
  const best = levels[0];
  const g = ff?.optionGreeks ?? first?.optionGreeks ?? {};
  const iv = num(ff?.iv ?? first?.iv);
  const q: OptionQuote = {
    key,
    price,
    time: num(ltpc?.ltt) ?? recvAt,
    recvAt,
    prevClose: pos(ltpc?.cp),
    bid: best?.bidP,
    ask: best?.askP,
    bidQty: best?.bidQ,
    askQty: best?.askQ,
    depth: levels.length ? levels : undefined,
    oi: num(ff?.oi ?? first?.oi),
    volume: num(ff?.vtt ?? first?.vtt),
    atp: pos(ff?.atp),
    ltq: pos(ltpc?.ltq),
    totalBuyQty: pos(ff?.tbq),
    totalSellQty: pos(ff?.tsq),
    iv: iv === undefined ? undefined : Math.round(iv * 100 * 100) / 100,
    delta: num(g.delta),
    theta: num(g.theta),
    gamma: num(g.gamma),
    vega: num(g.vega),
    rho: num(g.rho),
  };
  return q;
}

/** What is wrong with a quote that should not be published, or undefined. A momentarily crossed book is allowed, as for futures. */
export function optionQuoteProblem(q: OptionQuote, allowUntraded = false): string | undefined {
  if (!(q.price > 0) && !(allowUntraded && q.price === 0)) return "non-positive price";
  if (q.volume !== undefined && q.volume < 0) return "negative volume";
  if (q.oi !== undefined && q.oi < 0) return "negative open interest";
  if (q.delta !== undefined && Math.abs(q.delta) > 1.0001) return "delta outside -1 to 1";
  return undefined;
}

/** Seconds of lag the feed and our stream add, from the exchange's trade time to our receipt; undefined when the trade time is not credible (clock skew, no time). */
export function optionLagMs(q: OptionQuote): number | undefined {
  const lag = q.recvAt - q.time;
  return lag >= -2_000 && lag < 5 * 60_000 ? Math.max(0, lag) : undefined;
}
