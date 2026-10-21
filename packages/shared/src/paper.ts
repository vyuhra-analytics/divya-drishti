// Paper trading: simulated fills on live quotes with Upstox costs, stops and targets, and an account summary.
// Pure and tested; the store and engine in the web app only keep state and call these. Nothing here can place a real order.
import { roundTrip, UPSTOX_MCX_RATES, type CostRates, type Side } from "./costs";

export interface PaperQuote {
  price: number;
  bid?: number;
  ask?: number;
}

export interface PaperPosition {
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
}

export type ExitReason = "manual" | "stop" | "target";

export interface PaperTrade {
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
}

/** Where an order fills: at the book's far side when depth is known (ask to buy, bid to sell), else the last price, then `slippage` points worse. */
export function fillPrice(side: Side, q: PaperQuote, slippage: number): number {
  const ref = side === "buy" ? (q.ask ?? q.price) : (q.bid ?? q.price);
  return side === "buy" ? ref + slippage : ref - slippage;
}

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
  const rt = roundTrip("future", p.side, p.entry, exit, p.units, p.lots, rates);
  return { id: p.id, symbol: p.symbol, side: p.side, lots: p.lots, units: p.units, entry: p.entry, exit, openedAt: p.openedAt, closedAt: now, gross: rt.gross, costs: rt.costs.total, net: rt.net, reason, note };
}

/** Net P&L if the position were closed now (exit costs and slippage included). */
export function unrealisedNet(p: PaperPosition, q: PaperQuote, slippage: number, rates: CostRates = UPSTOX_MCX_RATES): number {
  return roundTrip("future", p.side, p.entry, fillPrice(opposite(p.side), q, slippage), p.units, p.lots, rates).net;
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
