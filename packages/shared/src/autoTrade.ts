// The automatic PAPER trade of the report-day and USIB signals: when a signal fires, a futures paper order is placed in a separate "auto" account, managed through
// the trade (stop to the entry at TP1, USIB's trail after TP2, the time exit) and closed. Simulated only: nothing here can reach a broker. The decisions are pure
// and tested; the browser (AutoPaper.tsx) carries them out against the stream's /paper API, where the stop and the target are held by the server.
import { fixedRiskLots, lotUnits, UPSTOX_MCX_RATES, type CostRates } from "./costs";
import { instrument } from "./index";
import { DAY_RULES, type DaySide } from "./reportDay";
import type { ManualTrade, TradeEvent, TradeView } from "./reportTrade";

/** The paper account the automatic trades use, kept apart from the owner's own and an agent's. It starts with the strategy capital. */
export const AUTO_ACCOUNT = "auto";
export const AUTO_CAPITAL = DAY_RULES.capital;

/** A signal is acted on only this long after its candle closed: armed after that, the entry is gone and the trade is skipped, never chased. */
export const AUTO_SIGNAL_MAX_AGE_MS = 120_000;

// The signal's levels come from the chart contract; the paper trade uses the mini contract of the same market, whose lot is a tenth of the size, so the
// Rs 2,000 loss cap can take whole lots (a standard crude lot loses more than that on a normal 1R stop).
const MINI: Record<string, string> = { "MCX:CRUDEOIL": "MCX:CRUDEOILM", "MCX:NATURALGAS": "MCX:NATGASMINI" };
export const autoSymbol = (chartSymbol: string) => MINI[chartSymbol] ?? chartSymbol;

export const signalFresh = (candleTimeSec: number, candleSec: number, now: number) => now - (candleTimeSec + candleSec) * 1000 <= AUTO_SIGNAL_MAX_AGE_MS;

export interface AutoPlan {
  symbol: string;
  side: "buy" | "sell";
  dir: DaySide;
  lots: number;
  units: number;
  /** the price the levels were worked out from (the ask for a buy, the bid for a sell) */
  ref: number;
  rPoints: number;
  stop: number;
  tp1: number;
  tp2: number;
  /** rupees lost at the stop with these lots, costs included */
  riskAtStop: number;
}

export interface PlanInput {
  chartSymbol: string;
  dir: DaySide;
  ref: number;
  rPoints?: number;
  /** USIB: its own TP2 (a chain level), used when it lies beyond TP1; else 2R */
  tp2?: number;
  rates?: CostRates;
}

const rs = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** Levels from R at the price we would trade at, and whole lots so the loss at the stop, costs included, stays inside the per-trade cap. A refusal says why. */
export function planAutoOrder(i: PlanInput): { ok: true; plan: AutoPlan } | { ok: false; reason: string } {
  const symbol = autoSymbol(i.chartSymbol);
  const units = lotUnits(symbol);
  const inst = instrument(symbol);
  if (!inst || inst.exchange !== "MCX" || units === undefined) return { ok: false, reason: `${symbol} is not an MCX contract the paper account trades` };
  if (!(i.rPoints !== undefined && i.rPoints > 0)) return { ok: false, reason: "the signal has no R yet (not enough candles for the ATR)" };
  if (!(i.ref > 0)) return { ok: false, reason: `no live price for ${symbol}` };
  const dir = i.dir === "long" ? 1 : -1;
  const dp = 10 ** inst.decimals;
  const round = (n: number) => Math.round(n * dp) / dp;
  const stop = round(i.ref - dir * i.rPoints);
  const tp1 = round(i.ref + dir * i.rPoints);
  const tp2 = i.tp2 !== undefined && (dir === 1 ? i.tp2 > tp1 : i.tp2 < tp1) ? round(i.tp2) : round(i.ref + dir * 2 * i.rPoints);
  const side = i.dir === "long" ? "buy" : "sell";
  const sized = fixedRiskLots({ side, equity: AUTO_CAPITAL, riskPct: (DAY_RULES.lossCap / AUTO_CAPITAL) * 100, entry: i.ref, stop, units, rates: i.rates ?? UPSTOX_MCX_RATES });
  if (!sized) return { ok: false, reason: "the stop is not on the losing side of the entry" };
  if (sized.lots < 1) return { ok: false, reason: `one lot of ${symbol} would lose about ${rs(sized.riskPerLot)} at the stop, over the ${rs(DAY_RULES.lossCap)} cap` };
  return { ok: true, plan: { symbol, side, dir: i.dir, lots: sized.lots, units, ref: i.ref, rPoints: i.rPoints, stop, tp1, tp2, riskAtStop: sized.riskAtStop } };
}

/** What is kept of an automatic trade, in the browser, so a reload carries on where it was. */
export interface AutoRecord {
  status: "placed" | "closed" | "skipped";
  /** why it was skipped, or how it closed */
  reason?: string;
  symbol?: string;
  dir?: DaySide;
  lots?: number;
  units?: number;
  /** the fill price, the original stop, and the levels */
  entry?: number;
  stop?: number;
  tp1?: number;
  tp2?: number;
  rPoints?: number;
  enteredAt?: number;
  positionId?: string;
  /** the stop the server holds now (it moves to the entry at TP1 and trails in USIB) */
  currentStop?: number;
  /** USIB: after TP2 no target closes the trade; the stop trails this many points */
  trail?: number;
  events: TradeEvent[];
  exit?: { at: number; price: number; net: number; reason: string };
}

/** The record as the trade tracker reads it (the option fields are unused: this is a futures trade). */
export function asManualTrade(rec: AutoRecord, releaseAt: number, timeStop?: { fromMin: number; toMin: number }): ManualTrade {
  return {
    releaseAt,
    enteredAt: rec.enteredAt ?? releaseAt,
    side: rec.dir ?? "long",
    futureEntry: rec.entry ?? 0,
    rPoints: rec.rPoints ?? 0,
    stop: rec.stop ?? 0,
    tp1: rec.tp1 ?? 0,
    tp2: rec.tp2 ?? 0,
    strike: 0,
    premium: 0,
    units: rec.units ?? 1,
    lots: rec.lots ?? 1,
    events: rec.events,
    ...(timeStop ? { timeStop } : {}),
    ...(rec.trail !== undefined ? { trail: rec.trail } : {}),
  };
}

export interface AutoDecision {
  /** the stop the server should hold now, when it is tighter than the one it has */
  moveStop?: number;
  /** close at the market: the time exit */
  closeTime?: boolean;
}

/**
 * What to do with an open automatic trade: at TP1 the stop goes to the entry; after TP2 in USIB it trails (the tracker's trailing stop); once the time window has
 * opened the trade is closed at the market. A stop is only ever moved TOWARD profit, never loosened.
 */
export function decideAuto(rec: AutoRecord, view: TradeView): AutoDecision {
  if (rec.status !== "placed" || rec.entry === undefined || rec.dir === undefined) return {};
  const long = rec.dir === "long";
  const tighter = (a: number, b: number) => (long ? Math.max(a, b) : Math.min(a, b));
  const held = rec.currentStop ?? rec.stop;
  let want = rec.stop ?? held;
  if (want === undefined || held === undefined) return {};
  if (view.events.some((e) => e.kind === "tp1")) want = tighter(want, rec.entry);
  if (view.trailing) want = tighter(want, view.stop);
  const out: AutoDecision = {};
  if (long ? want > held : want < held) out.moveStop = want;
  if (view.timeStop.state !== "before") out.closeTime = true;
  return out;
}

export const AUTO_EVENT_TEXT: Record<TradeEvent["kind"], string> = {
  tp1: "TP1 reached: the stop moves to the entry",
  tp2: "TP2 reached",
  stop: "the stop level was reached",
  cap: "the loss cap was reached",
  "timestop-open": "the time window has opened: the paper trade is closed at the market",
  timestop: "the time stop",
};
