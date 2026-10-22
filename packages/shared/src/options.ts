// MCX options chain assembly. Pure so strike selection, PCR and max pain are unit-tested.

/** Option contract row from Upstox's public instrument master (subset). expiry = epoch ms. */
export interface OptionContract {
  instrument_key: string;
  trading_symbol: string;
  instrument_type: "CE" | "PE";
  underlying_symbol: string;
  /** the future this option settles against (differs per expiry, e.g. NATURALGAS Oct options sit on the Oct future) */
  underlying_key: string;
  strike_price: number;
  expiry: number;
  lot_size?: number;
}

export interface OptionLeg {
  key: string;
  /** Upstox instrument key (MCX_FO|582939) when the leg is an Upstox contract: what the live feed is subscribed by */
  ukey?: string;
  ltp?: number;
  /** change vs previous close */
  change?: number;
  bid?: number;
  ask?: number;
  oi?: number;
  volume?: number;
  /** implied volatility, percent */
  iv?: number;
  delta?: number;
  theta?: number;
  vega?: number;
  gamma?: number;
  /** model (theoretical) price, when the feed supplies one */
  theo?: number;
  /** open interest at the baseline (see `Chain.oiBasis`) and the change since then, filled from our own stored snapshots: Upstox gives no previous OI for MCX options */
  prevOi?: number;
  oiChange?: number;
}

export interface ChainRow {
  strike: number;
  ce?: OptionLeg;
  pe?: OptionLeg;
}

export interface Chain {
  underlying: string;
  expiry: string; // YYYY-MM-DD
  expiries: string[];
  spot?: number;
  atm?: number;
  lot?: number;
  pcr?: number;
  maxPain?: number;
  rows: ChainRow[];
  updatedAt: number;
  /** which feed built it; TradingView has no open interest or volume, so "combined" = TradingView prices and greeks with Upstox open interest and volume */
  source?: "upstox" | "tradingview" | "combined";
  /** seconds the feed lags the exchange */
  delayedBy?: number;
  /** what `prevOi` / `oiChange` are measured against: the last snapshot of the previous session, or (until we have one) this session's first reading */
  oiBasis?: OiBasis;
}

export type OiBasis = "previous-close" | "session-open";

/** Stable key of one option leg across feeds and days (Upstox and TradingView name contracts differently). */
export const optionKey = (underlying: string, expiry: string, strike: number, side: "CE" | "PE") => `${underlying}|${expiry}|${strike}|${side}`;

/** Put open interest over call open interest at one strike; undefined without call OI. */
export function rowPcr(row: ChainRow): number | undefined {
  const c = row.ce?.oi ?? 0;
  return c > 0 && row.pe?.oi !== undefined ? row.pe.oi / c : undefined;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface OiBaseline {
  /** OI at the last snapshot of the previous session */
  prev?: number;
  /** OI at the first reading of this session */
  first?: number;
}

/**
 * Add `prevOi` and `oiChange` to every leg from stored snapshots (keyed by `optionKey`). The previous session's closing OI is the
 * baseline when we have it; otherwise this session's first reading, and the chain says which (`oiBasis`) so the screen can label it.
 * Returns a new chain; the cached one is left untouched.
 */
export function applyOiBaseline(chain: Chain, base: Map<string, OiBaseline>): Chain {
  let usedPrev = 0;
  let usedFirst = 0;
  const leg = (l: OptionLeg | undefined, side: "CE" | "PE", strike: number): OptionLeg | undefined => {
    if (!l || l.oi === undefined) return l;
    const b = base.get(optionKey(chain.underlying, chain.expiry, strike, side));
    const from = b?.prev ?? b?.first;
    if (from === undefined) return l;
    if (b?.prev !== undefined) usedPrev++;
    else usedFirst++;
    return { ...l, prevOi: from, oiChange: l.oi - from };
  };
  const rows = chain.rows.map((r) => ({ ...r, ce: leg(r.ce, "CE", r.strike), pe: leg(r.pe, "PE", r.strike) }));
  return { ...chain, rows, oiBasis: usedPrev >= usedFirst && usedPrev > 0 ? "previous-close" : usedFirst > 0 ? "session-open" : undefined };
}

export const expiryDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Distinct expiries (YYYY-MM-DD) of the underlying that haven't passed, soonest first. */
export function expiriesOf(contracts: OptionContract[], underlying: string, now: number): string[] {
  const ms = [...new Set(contracts.filter((c) => c.underlying_symbol === underlying && c.expiry + 86_400_000 > now).map((c) => c.expiry))];
  return ms.sort((a, b) => a - b).map(expiryDate);
}

/** Strike closest to spot (ties go to the lower strike). */
export function atmStrike(strikes: number[], spot: number): number | undefined {
  return [...strikes].sort((a, b) => a - b).reduce<number | undefined>((best, k) => (best === undefined || Math.abs(k - spot) < Math.abs(best - spot) ? k : best), undefined);
}

/** `each` strikes either side of ATM (all of them if fewer exist), ascending. */
export function pickStrikes(strikes: number[], spot: number, each = 12): number[] {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const atm = atmStrike(sorted, spot);
  if (atm === undefined) return [];
  const i = sorted.indexOf(atm);
  return sorted.slice(Math.max(0, i - each), i + each + 1);
}

/** Put/call ratio by open interest over the given rows. */
export function pcr(rows: ChainRow[]): number | undefined {
  const sum = (side: "ce" | "pe") => rows.reduce((t, r) => t + (r[side]?.oi ?? 0), 0);
  const calls = sum("ce");
  return calls > 0 ? sum("pe") / calls : undefined;
}

/** Max pain: the strike at which option writers pay out least, from the OI of the given rows. */
export function maxPain(rows: ChainRow[]): number | undefined {
  if (!rows.some((r) => (r.ce?.oi ?? 0) > 0 || (r.pe?.oi ?? 0) > 0)) return undefined; // no open interest at all: every strike would tie
  let best: { strike: number; pain: number } | undefined;
  for (const { strike: k } of rows) {
    const pain = rows.reduce((t, r) => t + (r.ce?.oi ?? 0) * Math.max(0, k - r.strike) + (r.pe?.oi ?? 0) * Math.max(0, r.strike - k), 0);
    if (!best || pain < best.pain) best = { strike: k, pain };
  }
  return best?.strike;
}

/** Quote fields we read from Upstox's /v2/market-quote/quotes entry. */
export interface UpstoxQuote {
  last_price?: number;
  net_change?: number;
  volume?: number;
  oi?: number;
  depth?: { buy?: { price: number }[]; sell?: { price: number }[] };
}
/** Greeks from /v3/market-quote/option-greek (iv is a fraction). */
export interface UpstoxGreeks {
  iv?: number;
  delta?: number;
  theta?: number;
  vega?: number;
  gamma?: number;
}

const bestPrice = (side?: { price: number }[]) => (side?.[0]?.price ? side[0].price : undefined);

/** Merge contracts with quotes and greeks (both keyed by instrument_key) into strike rows. */
export function buildRows(
  contracts: OptionContract[],
  quotes: Map<string, UpstoxQuote>,
  greeks: Map<string, UpstoxGreeks>,
): ChainRow[] {
  const byStrike = new Map<number, ChainRow>();
  for (const c of contracts) {
    const q = quotes.get(c.instrument_key);
    const g = greeks.get(c.instrument_key);
    const leg: OptionLeg = {
      key: c.instrument_key,
      ukey: c.instrument_key,
      ltp: q?.last_price,
      change: q?.net_change,
      bid: bestPrice(q?.depth?.buy),
      ask: bestPrice(q?.depth?.sell),
      oi: q?.oi,
      volume: q?.volume,
      iv: g?.iv === undefined ? undefined : g.iv * 100,
      delta: g?.delta,
      theta: g?.theta,
      vega: g?.vega,
      gamma: g?.gamma,
    };
    const row = byStrike.get(c.strike_price) ?? { strike: c.strike_price };
    row[c.instrument_type === "CE" ? "ce" : "pe"] = leg;
    byStrike.set(c.strike_price, row);
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

/**
 * TradingView's live prices, IV and greeks with Upstox's last trade, open interest and volume, strike by strike.
 * Both must be the same expiry. Strikes come from the TradingView chain; a strike Upstox does not carry keeps TradingView's
 * numbers only. PCR and max pain are recomputed from the merged open interest.
 */
export function mergeChains(tv: Chain, up: Chain): Chain {
  const upBy = new Map(up.rows.map((r) => [r.strike, r]));
  const mix = (a?: OptionLeg, b?: OptionLeg): OptionLeg | undefined => {
    if (!a) return b;
    if (!b) return a;
    return {
      ...a,
      ukey: b.ukey ?? a.ukey,
      ltp: b.ltp ?? a.ltp, // the last trade when there is one, else the TradingView midpoint
      change: b.change,
      oi: b.oi,
      volume: b.volume,
      // Upstox only fills what TradingView lacks (its greeks are optional on that side)
      iv: a.iv ?? b.iv,
      delta: a.delta ?? b.delta,
      theta: a.theta ?? b.theta,
      vega: a.vega ?? b.vega,
      gamma: a.gamma ?? b.gamma,
      bid: a.bid ?? b.bid,
      ask: a.ask ?? b.ask,
    };
  };
  const rows = tv.rows.map((r) => {
    const u = upBy.get(r.strike);
    return { strike: r.strike, ce: mix(r.ce, u?.ce), pe: mix(r.pe, u?.pe) };
  });
  return {
    ...tv,
    expiries: [...new Set([...tv.expiries, ...up.expiries])].sort(),
    lot: up.lot ?? tv.lot,
    spot: tv.spot ?? up.spot,
    pcr: pcr(rows),
    maxPain: maxPain(rows),
    rows,
    source: "combined",
  };
}
