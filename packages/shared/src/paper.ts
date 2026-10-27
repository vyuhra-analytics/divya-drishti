// Paper trading: simulated fills on live quotes with Upstox costs, stops and targets, and an account summary.
// Pure and tested; the store and engine in the web app only keep state and call these. Nothing here can place a real order.
import { roundTrip, UPSTOX_MCX_RATES, type CostRates, type Side } from "./costs";

export interface PaperQuote {
  price: number;
  bid?: number;
  ask?: number;
  /** which feed the quote came from, and its time (epoch ms), kept on fills so a trade can be reconciled with its source */
  source?: string;
  time?: number;
}

/** How one fill was priced: the quote it used, the book price it started from, and the slippage added. */
export interface FillDetail {
  /** the quote used */
  quote: { price: number; bid?: number; ask?: number; source?: string; time?: number };
  /** the price before slippage: the ask for a buy, the bid for a sell, else the last price */
  reference: number;
  slippageTicks: number;
  slippagePoints: number;
  /** the price the order filled at */
  price: number;
}

/** Describe a fill for the record. `slippagePoints` is what was added against the trader; `tick` is the contract's price step. */
export function describeFill(side: Side, q: PaperQuote, slippagePoints: number, tick: number): FillDetail {
  const reference = side === "buy" ? (q.ask ?? q.price) : (q.bid ?? q.price);
  return {
    quote: { price: q.price, ...(q.bid !== undefined ? { bid: q.bid } : {}), ...(q.ask !== undefined ? { ask: q.ask } : {}), ...(q.source ? { source: q.source } : {}), ...(q.time !== undefined ? { time: q.time } : {}) },
    reference,
    slippageTicks: Number((slippagePoints / tick).toFixed(4)),
    slippagePoints: round6(slippagePoints),
    price: round6(side === "buy" ? reference + slippagePoints : reference - slippagePoints),
  };
}

/** Labels an order carries so a trade can be reconciled with the strategy's own records. All optional. */
export interface OrderMeta {
  /** the caller's own id for this order: a retry with the same id never doubles the position */
  clientOrderId?: string;
  tag?: string;
  strategy?: string;
  /** when the signal fired (epoch ms), e.g. the candle close the strategy acted on */
  signalTime?: number;
  /** the risk unit in price points (entry to initial stop): the trade's R multiple is its move divided by this */
  rPoints?: number;
}

/** An option contract a position is in (paper option trading, buy only): the Upstox key, what to call it, and the premium's price step in rupees. */
export interface OptionRef {
  key: string;
  label: string;
  underlying: string;
  type: "CE" | "PE";
  strike: number;
  /** YYYY-MM-DD */
  expiry: string;
  /** the premium's price step in rupees (Upstox lists it in paise) */
  tick: number;
}

export interface PaperPosition extends OrderMeta {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  /** units per lot */
  units: number;
  /** fill price, slippage included */
  entry: number;
  stop?: number;
  target?: number;
  openedAt: number;
  /** who opened it: "ui" (the browser) or "mcp" (an agent). Absent on positions from before accounts moved to the server. */
  actor?: string;
  /** how the entry was priced: quote, slippage (absent on positions opened before fills were recorded) */
  fill?: FillDetail;
  /** set for an option position: `symbol` is then the Upstox instrument key, prices are premiums and costs use the option rates */
  option?: OptionRef;
}

export type ExitReason = "manual" | "stop" | "target";

export interface PaperTrade extends OrderMeta {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  units: number;
  entry: number;
  exit: number;
  openedAt: number;
  closedAt: number;
  gross: number;
  costs: number;
  net: number;
  reason: ExitReason;
  note: string;
  /** who opened it, and who closed it ("engine" when a stop or target fired) */
  actor?: string;
  closedBy?: string;
  /** how the entry and the exit were priced */
  entryFill?: FillDetail;
  exitFill?: FillDetail;
  /** the move in the trade's favour (before costs) divided by `rPoints`; only when the order gave an R */
  rMultiple?: number;
  /** set for an option trade */
  option?: OptionRef;
}

/** Where an order fills: at the book's far side when depth is known (ask to buy, bid to sell), else the last price, then `slippage` points worse. */
export function fillPrice(side: Side, q: PaperQuote, slippage: number): number {
  const ref = side === "buy" ? (q.ask ?? q.price) : (q.bid ?? q.price);
  return round6(side === "buy" ? ref + slippage : ref - slippage); // 270.1 + 0.1 is 270.20000000000005 in floating point: a recorded price must be the price
}

const round6 = (n: number) => Number(n.toFixed(6));

const opposite = (s: Side): Side => (s === "buy" ? "sell" : "buy");

export interface OpenInput {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  units: number;
  stop?: number;
  target?: number;
}

/** Open a position, or explain why not: a stop must be on the losing side of the fill and a target on the winning side. */
export function openPaper(i: OpenInput, q: PaperQuote, slippage: number, now: number): PaperPosition | { error: string } {
  if (!(i.lots >= 1) || !Number.isInteger(i.lots)) return { error: "Lots must be a whole number of at least 1." };
  const entry = fillPrice(i.side, q, slippage);
  const long = i.side === "buy";
  if (i.stop !== undefined && (long ? i.stop >= entry : i.stop <= entry)) return { error: `A ${long ? "long" : "short"}'s stop must be ${long ? "below" : "above"} the fill price (${entry}).` };
  if (i.target !== undefined && (long ? i.target <= entry : i.target >= entry)) return { error: `A ${long ? "long" : "short"}'s target must be ${long ? "above" : "below"} the fill price (${entry}).` };
  return { id: i.id, symbol: i.symbol, side: i.side, lots: i.lots, units: i.units, entry, stop: i.stop, target: i.target, openedAt: now };
}

/** Has the market reached the stop or the target? The stop wins when both are in reach (the worse outcome is assumed). */
export function exitHit(p: PaperPosition, price: number): "stop" | "target" | undefined {
  const long = p.side === "buy";
  if (p.stop !== undefined && (long ? price <= p.stop : price >= p.stop)) return "stop";
  if (p.target !== undefined && (long ? price >= p.target : price <= p.target)) return "target";
  return undefined;
}

/** Close at the market (not at the stop price: a gap through a stop fills where the market is), with slippage and full costs. */
export function closePaper(p: PaperPosition, q: PaperQuote, slippage: number, now: number, reason: ExitReason, rates: CostRates = UPSTOX_MCX_RATES, note = ""): PaperTrade {
  const exit = fillPrice(opposite(p.side), q, slippage);
  const rt = roundTrip(p.option ? "option" : "future", p.side, p.entry, exit, p.units, p.lots, rates);
  return { id: p.id, symbol: p.symbol, side: p.side, lots: p.lots, units: p.units, entry: p.entry, exit, openedAt: p.openedAt, closedAt: now, gross: rt.gross, costs: rt.costs.total, net: rt.net, reason, note, ...(p.option ? { option: p.option } : {}) };
}

/** Net P&L if the position were closed now (exit costs and slippage included). */
export function unrealisedNet(p: PaperPosition, q: PaperQuote, slippage: number, rates: CostRates = UPSTOX_MCX_RATES): number {
  return roundTrip(p.option ? "option" : "future", p.side, p.entry, fillPrice(opposite(p.side), q, slippage), p.units, p.lots, rates).net;
}

export interface Account {
  realised: number;
  unrealised: number;
  /** starting capital + realised + unrealised */
  equity: number;
  costsPaid: number;
  trades: number;
  winRate: number;
  /** largest fall of realised equity from its peak, rupees */
  maxDrawdown: number;
}

/** Account figures from the closed trades (oldest first) and the open positions' current net. */
export function summarizeAccount(capital: number, trades: PaperTrade[], openNets: number[]): Account {
  const realised = trades.reduce((s, t) => s + t.net, 0);
  const unrealised = openNets.reduce((s, n) => s + n, 0);
  let run = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    run += t.net;
    peak = Math.max(peak, run);
    dd = Math.max(dd, peak - run);
  }
  return {
    realised,
    unrealised,
    equity: capital + realised + unrealised,
    costsPaid: trades.reduce((s, t) => s + t.costs, 0),
    trades: trades.length,
    winRate: trades.length ? trades.filter((t) => t.net > 0).length / trades.length : 0,
    maxDrawdown: dd,
  };
}
