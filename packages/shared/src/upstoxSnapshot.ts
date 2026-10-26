// One contract of Upstox's REST snapshot (`/v2/market-quote/quotes` full quote + `/v3/market-quote/option-greek`) as a flat row for `quote_snapshots`.
// The live feed carries most of this, but not the circuit limits, the day's OI high/low or the order count at each depth level, and the feed
// only sends contracts that change: a snapshot is the whole chain at one moment. Pure, so the parsing is tested against a recorded response.

export interface SnapshotDepth {
  buy: { quantity: number; price: number; orders: number }[];
  sell: { quantity: number; price: number; orders: number }[];
}

export interface SnapshotRow {
  at: number;
  key: string;
  symbol?: string;
  lastPrice?: number;
  lastTradeAt?: number;
  ltq?: number;
  volume?: number;
  averagePrice?: number;
  oi?: number;
  oiDayHigh?: number;
  oiDayLow?: number;
  netChange?: number;
  prevClose?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  lowerCircuit?: number;
  upperCircuit?: number;
  depth?: SnapshotDepth;
  iv?: number;
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
}

const n = (v: unknown): number | undefined => {
  const x = v === undefined || v === null || v === "" ? NaN : Number(v);
  return Number.isFinite(x) ? x : undefined;
};
/** a value where zero means "nothing" (a price, a trade time) */
const pos = (v: unknown) => {
  const x = n(v);
  return x !== undefined && x > 0 ? x : undefined;
};

const level = (l: any) => ({ quantity: n(l?.quantity) ?? 0, price: n(l?.price) ?? 0, orders: n(l?.orders) ?? 0 });
const levels = (side: any): SnapshotDepth["buy"] => (Array.isArray(side) ? side.map(level).filter((l) => l.quantity > 0 || l.price > 0) : []);

/** `entry` is one value of the full-quote `data` map, `greek` the matching option-greek entry (absent for a future or when that call failed). */
export function snapshotRow(at: number, entry: any, greek?: any): SnapshotRow | undefined {
  const key = typeof entry?.instrument_token === "string" ? entry.instrument_token : undefined;
  if (!key) return undefined;
  const buy = levels(entry?.depth?.buy);
  const sell = levels(entry?.depth?.sell);
  const iv = n(greek?.iv);
  const hasGreeks = iv !== undefined && iv > 0;
  return {
    at,
    key,
    symbol: typeof entry.symbol === "string" ? entry.symbol : undefined,
    lastPrice: pos(entry.last_price),
    lastTradeAt: pos(entry.last_trade_time),
    ltq: pos(greek?.ltq),
    volume: n(entry.volume),
    averagePrice: pos(entry.average_price),
    oi: n(entry.oi),
    oiDayHigh: n(entry.oi_day_high),
    oiDayLow: n(entry.oi_day_low),
    netChange: n(entry.net_change),
    prevClose: pos(greek?.cp),
    open: pos(entry.ohlc?.open),
    high: pos(entry.ohlc?.high),
    low: pos(entry.ohlc?.low),
    close: pos(entry.ohlc?.close),
    totalBuyQty: n(entry.total_buy_quantity),
    totalSellQty: n(entry.total_sell_quantity),
    lowerCircuit: pos(entry.lower_circuit_limit),
    upperCircuit: pos(entry.upper_circuit_limit),
    depth: buy.length || sell.length ? { buy, sell } : undefined,
    iv: hasGreeks ? Math.round(iv! * 100 * 100) / 100 : undefined, // the API sends a fraction; we keep percent like everywhere else
    delta: hasGreeks ? n(greek.delta) : undefined,
    theta: hasGreeks ? n(greek.theta) : undefined,
    gamma: hasGreeks ? n(greek.gamma) : undefined,
    vega: hasGreeks ? n(greek.vega) : undefined,
  };
}

/** Both responses' `data` maps joined by instrument key. A greek entry with no matching quote is dropped. */
export function snapshotRows(at: number, quotes: Record<string, any>, greeks: Record<string, any>): SnapshotRow[] {
  const byKey = new Map<string, any>(Object.values(greeks).flatMap((g: any) => (typeof g?.instrument_token === "string" ? [[g.instrument_token, g] as [string, any]] : [])));
  return Object.values(quotes).flatMap((e: any) => {
    const row = snapshotRow(at, e, byKey.get(e?.instrument_token));
    return row ? [row] : [];
  });
}

/** Splits a list into pieces of at most `size` (a URL carries only so many instrument keys). */
export function pieces<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
