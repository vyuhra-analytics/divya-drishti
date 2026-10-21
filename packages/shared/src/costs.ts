// MCX cost engine: what a trade really costs on Upstox, and a fixed-risk position sizer. Base for the strategy tester and paper trading.
// Rates are a configurable table, not constants in the logic: verify them against your own Upstox contract note.
// Pure and tested.
import { instrument } from "./index";

export interface CostRates {
  /** flat brokerage per executed order, rupees */
  brokerageFlat: number;
  /** commodity transaction tax on the sell side, share of turnover (non-agri futures 0.01%, options 0.05% of premium) */
  cttFutures: number;
  cttOptions: number;
  /** MCX exchange transaction charge, share of turnover (options: of premium) */
  exchangeFutures: number;
  exchangeOptions: number;
  /** SEBI turnover fee, share of turnover (rupees 10 per crore) */
  sebi: number;
  /** stamp duty on the buy side, share of turnover */
  stampFutures: number;
  stampOptions: number;
  /** GST on brokerage + exchange charge + SEBI fee */
  gst: number;
}

/**
 * Upstox MCX non-agri schedule as published in its help centre and MCX's April 2026 master circular (see CLAUDE.md).
 * The Upstox pricing page lists the futures exchange charge as 0.0026% while its help centre and MCX say 0.0021%: the
 * table uses 0.0021%, so check a real contract note. ponytail: no percentage cap on brokerage; flat per order only.
 */
export const UPSTOX_MCX_RATES: CostRates = {
  brokerageFlat: 20,
  cttFutures: 0.0001,
  cttOptions: 0.0005,
  exchangeFutures: 0.000021,
  exchangeOptions: 0.000418,
  sebi: 0.000001,
  stampFutures: 0.00002,
  stampOptions: 0.00003,
  gst: 0.18,
};

export type Side = "buy" | "sell";
export type Kind = "future" | "option";

export interface CostBreakdown {
  turnover: number;
  brokerage: number;
  ctt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

/** Units per lot from the instrument's lot text ("100 bbl" → 100, "1250 mmBtu" → 1250); undefined for an unknown symbol. */
export const lotUnits = (symbol: string): number | undefined => {
  const n = parseFloat(instrument(symbol)?.lot ?? "");
  return Number.isFinite(n) ? n : undefined;
};

/** Charges on one order. `price` is the traded price (option: the premium), `units` the units per lot. */
export function legCosts(kind: Kind, side: Side, price: number, units: number, lots: number, rates: CostRates = UPSTOX_MCX_RATES): CostBreakdown {
  const turnover = price * units * lots;
  const opt = kind === "option";
  const brokerage = rates.brokerageFlat;
  const ctt = side === "sell" ? turnover * (opt ? rates.cttOptions : rates.cttFutures) : 0;
  const exchange = turnover * (opt ? rates.exchangeOptions : rates.exchangeFutures);
  const sebi = turnover * rates.sebi;
  const stamp = side === "buy" ? turnover * (opt ? rates.stampOptions : rates.stampFutures) : 0;
  const gst = (brokerage + exchange + sebi) * rates.gst;
  return { turnover, brokerage, ctt, exchange, sebi, stamp, gst, total: brokerage + ctt + exchange + sebi + stamp + gst };
}

const sum = (a: CostBreakdown, b: CostBreakdown): CostBreakdown => ({
  turnover: a.turnover + b.turnover,
  brokerage: a.brokerage + b.brokerage,
  ctt: a.ctt + b.ctt,
  exchange: a.exchange + b.exchange,
  sebi: a.sebi + b.sebi,
  stamp: a.stamp + b.stamp,
  gst: a.gst + b.gst,
  total: a.total + b.total,
});

export interface RoundTrip {
  /** price move times units times lots, before any cost; negative for a loss */
  gross: number;
  costs: CostBreakdown;
  net: number;
  /** price points the trade must move in its favour just to pay its costs */
  breakevenPoints: number;
}

/** Entry then exit of `side` (a long is buy then sell; a short is sell then buy): the gross-to-net bridge. */
export function roundTrip(kind: Kind, side: Side, entry: number, exit: number, units: number, lots: number, rates: CostRates = UPSTOX_MCX_RATES): RoundTrip {
  const other: Side = side === "buy" ? "sell" : "buy";
  const costs = sum(legCosts(kind, side, entry, units, lots, rates), legCosts(kind, other, exit, units, lots, rates));
  const gross = (side === "buy" ? exit - entry : entry - exit) * units * lots;
  return { gross, costs, net: gross - costs.total, breakevenPoints: costs.total / (units * lots) };
}

export interface SizerInput {
  kind?: Kind;
  side: Side;
  equity: number;
  /** share of equity risked on the trade, percent */
  riskPct: number;
  entry: number;
  stop: number;
  units: number;
  rates?: CostRates;
}

export interface Sized {
  lots: number;
  /** rupees risked per lot if the stop is hit: the price move to the stop plus the round-trip costs */
  riskPerLot: number;
  /** equity × risk % */
  riskBudget: number;
  /** rupees lost at the stop with this many lots, costs included */
  riskAtStop: number;
}

/** Whole lots whose loss at the stop, costs included, stays inside the risk budget. Zero lots when even one lot is too big; undefined for an unusable input (stop on the wrong side, no distance). */
export function fixedRiskLots(i: SizerInput): Sized | undefined {
  const { side, entry, stop, units } = i;
  const against = side === "buy" ? entry - stop : stop - entry;
  if (!(against > 0) || !(units > 0) || !(i.equity > 0) || !(i.riskPct > 0)) return undefined;
  const riskBudget = (i.equity * i.riskPct) / 100;
  const oneLot = roundTrip(i.kind ?? "future", side, entry, stop, units, 1, i.rates);
  const riskPerLot = -oneLot.net;
  const lots = Math.max(0, Math.floor(riskBudget / riskPerLot));
  // costs do not scale linearly (flat brokerage per order), so size, then confirm the full order still fits and step down if not
  let n = lots;
  while (n > 0 && -roundTrip(i.kind ?? "future", side, entry, stop, units, n, i.rates).net > riskBudget) n--;
  return { lots: n, riskPerLot, riskBudget, riskAtStop: n > 0 ? -roundTrip(i.kind ?? "future", side, entry, stop, units, n, i.rates).net : 0 };
}
