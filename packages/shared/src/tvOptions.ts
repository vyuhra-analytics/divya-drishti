// MCX options from TradingView's public options scanner (`options/scan2`): live bid/ask, theoretical price, IV and greeks
// per strike, one underlying future at a time. No open interest or volume (TradingView leaves them empty for options),
// so the Upstox feed stays the source for those. Pure parsing and chain building, tested against a recorded response.
import { atmStrike, expiryDate, maxPain, pcr, pickStrikes, type Chain, type ChainRow, type OptionLeg } from "./options";
import { tvContract } from "./index";

/** Columns requested from the scanner, in this order (the parser reads rows by it). */
export const TV_OPTION_COLUMNS = [
  "bid", "ask", "theoPrice", "iv", "delta", "gamma", "theta", "vega", "rho", "strike", "expiration", "option-type", "update_mode", "underlying_symbol",
] as const;

export interface TvOptionRow {
  symbol: string;
  type: "call" | "put";
  strike: number;
  /** epoch ms of the expiry day (UTC midnight) */
  expiry: number;
  underlying: string;
  bid?: number;
  ask?: number;
  theo?: number;
  /** fraction (0.56 = 56%) */
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  /** seconds the feed lags the exchange (0 = streaming) */
  delayedBy: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** YYYYMMDD integer → epoch ms (UTC midnight). */
const yyyymmdd = (n: number) => Date.UTC(Math.floor(n / 10000), Math.floor((n % 10000) / 100) - 1, n % 100);

/** `options/scan2` response → rows. Rows without a type, strike or expiry are skipped. */
export function parseTvOptions(json: any): TvOptionRow[] {
  const out: TvOptionRow[] = [];
  for (const r of json?.symbols ?? []) {
    const f: unknown[] = r.f ?? [];
    const [bid, ask, theo, iv, delta, gamma, theta, vega, rho, strike, expiration, type, mode, underlying] = f;
    if ((type !== "call" && type !== "put") || num(strike) === undefined || num(expiration) === undefined) continue;
    out.push({
      symbol: String(r.s),
      type,
      strike: strike as number,
      expiry: yyyymmdd(expiration as number),
      underlying: typeof underlying === "string" ? underlying : "",
      bid: num(bid),
      ask: num(ask),
      theo: num(theo),
      iv: num(iv),
      delta: num(delta),
      gamma: num(gamma),
      theta: num(theta),
      vega: num(vega),
      rho: num(rho),
      delayedBy: Number(/delayed_streaming_(\d+)/.exec(String(mode ?? ""))?.[1] ?? 0),
    });
  }
  return out;
}

/** Candidate underlying futures for a root: this month and the next `count - 1`, as TradingView dated codes (CRUDEOILX2026). */
export function tvUnderlyings(root: string, exchange: string, now: number, count = 4): { code: string; ticker: string }[] {
  const d = new Date(now);
  return Array.from({ length: count }, (_, i) => {
    const code = tvContract(root, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1));
    return { code, ticker: `${exchange}:${code}` };
  });
}

/** A leg's price: the bid/ask midpoint when both sides are quoted, else TradingView's theoretical price. */
export const legPrice = (r: Pick<TvOptionRow, "bid" | "ask" | "theo">): number | undefined =>
  r.bid !== undefined && r.ask !== undefined && r.bid > 0 && r.ask > 0 ? (r.bid + r.ask) / 2 : r.theo;

const toLeg = (r: TvOptionRow): OptionLeg => ({
  key: r.symbol,
  ltp: legPrice(r),
  bid: r.bid !== undefined && r.bid > 0 ? r.bid : undefined,
  ask: r.ask !== undefined && r.ask > 0 ? r.ask : undefined,
  iv: r.iv === undefined ? undefined : r.iv * 100,
  delta: r.delta,
  gamma: r.gamma,
  theta: r.theta,
  vega: r.vega,
  theo: r.theo,
});

/**
 * One expiry's chain from scanner rows: ±`each` strikes around the future's price, a call and a put per strike.
 * Open interest is absent, so PCR and max pain stay undefined (the Upstox feed fills them when it is available).
 */
export function buildTvChain(rows: TvOptionRow[], opts: { underlying: string; expiries: string[]; expiry: number; spot?: number; each?: number; now: number }): Chain {
  const of = rows.filter((r) => r.expiry === opts.expiry);
  const strikes = [...new Set(of.map((r) => r.strike))].sort((a, b) => a - b);
  const mid = opts.spot ?? strikes[Math.floor(strikes.length / 2)];
  const keep = new Set(mid === undefined ? [] : pickStrikes(strikes, mid, opts.each ?? 12));
  const byStrike = new Map<number, ChainRow>();
  for (const r of of) {
    if (!keep.has(r.strike)) continue;
    const row = byStrike.get(r.strike) ?? { strike: r.strike };
    row[r.type === "call" ? "ce" : "pe"] = toLeg(r);
    byStrike.set(r.strike, row);
  }
  const chainRows = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  return {
    underlying: opts.underlying,
    expiry: expiryDate(opts.expiry),
    expiries: opts.expiries,
    spot: opts.spot,
    atm: opts.spot === undefined ? undefined : atmStrike([...keep], opts.spot),
    pcr: pcr(chainRows),
    maxPain: maxPain(chainRows),
    rows: chainRows,
    updatedAt: opts.now,
    source: "tradingview",
    delayedBy: Math.max(0, ...of.map((r) => r.delayedBy)),
  };
}
