// Your open MCX positions from Upstox, reduced to what the briefing needs. Pure: tested against the documented response shape.
import { INSTRUMENTS } from "./index";

/** Upstox GET /v2/portfolio/short-term-positions row (subset). */
export interface UpstoxPositionRow {
  exchange?: string;
  trading_symbol?: string;
  tradingsymbol?: string;
  /** net open quantity, negative when short */
  quantity?: number;
  average_price?: number | null;
  buy_price?: number | null;
  sell_price?: number | null;
  last_price?: number;
  pnl?: number;
  product?: string;
}

export interface OpenPosition {
  /** our instrument, e.g. MCX:CRUDEOIL */
  symbol: string;
  /** Upstox trading symbol, e.g. "CRUDEOIL 19 NOV 26 FUT" */
  contract: string;
  kind: "future" | "option";
  /** net quantity as Upstox reports it (negative = short) */
  netQty: number;
  avgPrice?: number;
  lastPrice?: number;
  /** INR, as Upstox reports it (realised + unrealised for the day's position) */
  pnl?: number;
}

/** Open (non-zero) MCX positions in our four energy underlyings. Anything else in the account is ignored. */
export function parseUpstoxPositions(rows: UpstoxPositionRow[]): OpenPosition[] {
  const byUnderlying = new Map(INSTRUMENTS.filter((i) => i.upstox && i.exchange === "MCX").map((i) => [i.upstox!, i.symbol]));
  const out: OpenPosition[] = [];
  for (const r of rows) {
    const contract = (r.trading_symbol ?? r.tradingsymbol ?? "").trim();
    const symbol = byUnderlying.get(contract.split(/\s+/)[0]);
    if (r.exchange !== "MCX" || !symbol || !r.quantity) continue;
    const kind = /\b(CE|PE)\b/.test(contract) ? "option" : "future";
    const avg = r.average_price ?? (r.quantity > 0 ? r.buy_price : r.sell_price) ?? undefined;
    out.push({ symbol, contract, kind, netQty: r.quantity, avgPrice: avg ?? undefined, lastPrice: r.last_price, pnl: r.pnl });
  }
  return out;
}

/**
 * What the briefing is told about the position in this instrument. "unavailable" (couldn't read the account) is not the
 * same as "flat" (read it, nothing open): the model must not assume either way.
 */
export type PositionContext =
  | { status: "unavailable" }
  | { status: "flat"; optionPositionsOpen?: number }
  | { status: "open"; contract: string; side: "long" | "short"; netQty: number; avgPrice?: number; lastPrice?: number; pnl?: number; optionPositionsOpen?: number };

export function positionContext(symbol: string, positions: OpenPosition[] | undefined): PositionContext {
  if (!positions) return { status: "unavailable" };
  const mine = positions.filter((p) => p.symbol === symbol);
  const fut = mine.find((p) => p.kind === "future");
  const options = mine.filter((p) => p.kind === "option").length || undefined;
  if (!fut) return { status: "flat", optionPositionsOpen: options };
  return {
    status: "open",
    contract: fut.contract,
    side: fut.netQty > 0 ? "long" : "short",
    netQty: fut.netQty,
    avgPrice: fut.avgPrice,
    lastPrice: fut.lastPrice,
    pnl: fut.pnl,
    optionPositionsOpen: options,
  };
}
