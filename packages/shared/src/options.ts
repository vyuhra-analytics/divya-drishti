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
  /** which feed built it; TradingView has no open interest or volume */
  source?: "upstox" | "tradingview";
  /** seconds the feed lags the exchange */
  delayedBy?: number;
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
    };
    const row = byStrike.get(c.strike_price) ?? { strike: c.strike_price };
    row[c.instrument_type === "CE" ? "ce" : "pe"] = leg;
    byStrike.set(c.strike_price, row);
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}
