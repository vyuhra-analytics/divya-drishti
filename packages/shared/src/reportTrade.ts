// The in-trade and done stages of the EIA report-day screen (docs/redesign/EIA_SCREENS.md): the trader enters and exits BY HAND, and the screen follows the
// trade: the future against its entry, stop, TP1 and TP2, the result in R, the option's rupee P&L against the loss cap, the clock against the time stop,
// and, when it is over, a review. Nothing here places an order. Pure and tested.
import { DAY_RULES, type DayBar, type DaySide } from "./reportDay";

/** The time stop window after the print: from 90 minutes (21:30 IST in summer) to 120 (22:00); the same offsets after the clock change. */
export const TIME_STOP = { fromMin: 90, toMin: 120 } as const;

export interface ManualTrade {
  /** the release this trade belongs to (epoch ms) and when the trader says they entered */
  releaseAt: number;
  enteredAt: number;
  side: DaySide;
  /** the future's price at entry and the levels from R at that price */
  futureEntry: number;
  rPoints: number;
  stop: number;
  tp1: number;
  tp2: number;
  /** the option bought: its strike, the Upstox key (to follow its live quote), the premium paid per unit, units per lot, lots, and its delta at entry */
  strike: number;
  optionKey?: string;
  premium: number;
  units: number;
  lots: number;
  delta?: number;
  /** what the trade has done so far (kept so a reload does not forget it) */
  events: TradeEvent[];
}

export type TradeEventKind = "tp1" | "tp2" | "stop" | "cap" | "timestop-open" | "timestop";

export interface TradeEvent {
  kind: TradeEventKind;
  /** epoch ms */
  at: number;
  price?: number;
}

export type TradeStatus = "open" | "stopped" | "tp2";

export interface TradeView {
  status: TradeStatus;
  /** the favourable move of the future since entry, in points and as a multiple of R (negative against you) */
  move: number;
  rMultiple: number;
  /** the stop in force: the entry once TP1 has been reached */
  stop: number;
  stopAtEntry: boolean;
  /** the option marked at its bid, and the rupee result against the premium paid; undefined without a quote */
  optionBid?: number;
  pnl?: number;
  /** the loss at 1R in rupees: R x delta x units x lots, when the delta is known */
  rupeeR?: number;
  capHit: boolean;
  timeStop: { opensAt: number; hardAt: number; state: "before" | "window" | "past" };
  /** every event so far, oldest first, the ones recorded earlier included; `fresh` are the ones this call found */
  events: TradeEvent[];
  fresh: TradeEvent[];
}

const has = (events: readonly TradeEvent[], kind: TradeEventKind) => events.some((e) => e.kind === kind);

/**
 * Follow the trade. `bars` are the future's 5-minute candles, `price` its live price, `optionBid` the option's bid now. Candles that opened after the entry
 * candle count with their whole range (the entry candle itself and the live price count as a point at `price`, since part of the candle came before the
 * entry). Within a candle the stop is assumed hit before a target, and once TP1 has been reached the stop sits at the entry from the NEXT candle on. TP2
 * ends the follow-up. Events found earlier (`trade.events`) are kept and never found twice.
 */
export function trackTrade(trade: ManualTrade, bars: readonly DayBar[], price: number | undefined, optionBid: number | undefined, now: number): TradeView {
  const dir = trade.side === "long" ? 1 : -1;
  const events = [...trade.events];
  const fresh: TradeEvent[] = [];
  const add = (kind: TradeEventKind, at: number, p?: number) => {
    if (has(events, kind)) return;
    const e = { kind, at, price: p };
    events.push(e);
    fresh.push(e);
  };

  const entryCandle = Math.floor(trade.enteredAt / 1000 / DAY_RULES.candleSec) * DAY_RULES.candleSec;
  // the candles after the entry one with their whole range, then the live price as a point
  const steps: { at: number; high: number; low: number }[] = [...bars]
    .filter((b) => b.time > entryCandle)
    .sort((a, b) => a.time - b.time)
    .map((b) => ({ at: (b.time + DAY_RULES.candleSec) * 1000, high: b.high, low: b.low }));
  if (price !== undefined) steps.push({ at: now, high: price, low: price });

  let tp1Before = has(events, "tp1"); // the stop sits at the entry from the candle AFTER the one that reached TP1
  let status: TradeStatus = has(events, "stop") ? "stopped" : has(events, "tp2") ? "tp2" : "open";
  for (const s of status === "open" ? steps : []) {
    const stopLevel = tp1Before ? trade.futureEntry : trade.stop;
    const best = dir === 1 ? s.high : s.low;
    const worst = dir === 1 ? s.low : s.high;
    if (dir === 1 ? worst <= stopLevel : worst >= stopLevel) {
      add("stop", s.at, stopLevel);
      status = "stopped";
      break;
    }
    const reached = (level: number) => (dir === 1 ? best >= level : best <= level);
    if (reached(trade.tp1)) add("tp1", s.at, trade.tp1);
    if (reached(trade.tp2)) {
      add("tp2", s.at, trade.tp2);
      status = "tp2";
      break;
    }
    tp1Before = has(events, "tp1");
  }

  const stopAtEntry = has(events, "tp1");
  const stop = stopAtEntry ? trade.futureEntry : trade.stop;
  const move = price === undefined ? 0 : dir * (price - trade.futureEntry);
  const rupeeR = trade.delta === undefined ? undefined : trade.rPoints * Math.abs(trade.delta) * trade.units * trade.lots;
  const pnl = optionBid === undefined ? undefined : (optionBid - trade.premium) * trade.units * trade.lots;
  const capHit = (pnl !== undefined && pnl <= -DAY_RULES.lossCap) || has(events, "cap");
  if (pnl !== undefined && pnl <= -DAY_RULES.lossCap) add("cap", now);

  const opensAt = trade.releaseAt + TIME_STOP.fromMin * 60_000;
  const hardAt = trade.releaseAt + TIME_STOP.toMin * 60_000;
  const state = now >= hardAt ? "past" : now >= opensAt ? "window" : "before";
  if (now >= opensAt) add("timestop-open", opensAt);
  if (now >= hardAt) add("timestop", hardAt);

  return { status, move, rMultiple: trade.rPoints > 0 ? move / trade.rPoints : 0, stop, stopAtEntry, optionBid, pnl, rupeeR, capHit, timeStop: { opensAt, hardAt, state }, events, fresh };
}

export type TradeExitReason = "stop" | "tp1" | "tp2" | "cap" | "time" | "manual";

export interface ClosedTrade extends ManualTrade {
  exitedAt: number;
  /** the premium the option was sold at and why the trader says they got out */
  exitPremium: number;
  reason: TradeExitReason;
  note: string;
}

export interface TradeReview {
  /** the rupee result on the option, and as a multiple of the loss at 1R when that is known */
  pnl: number;
  rResult?: number;
  /** the option's move as a percentage of the premium paid */
  optionPct: number;
  heldMinutes: number;
  /** the milestones the future reached while the trade was open */
  reached: { tp1: boolean; tp2: boolean; stop: boolean; cap: boolean };
}

/** What happened, in numbers, once the trader has exited. */
export function reviewTrade(t: ClosedTrade): TradeReview {
  const pnl = (t.exitPremium - t.premium) * t.units * t.lots;
  const rupeeR = t.delta === undefined ? undefined : t.rPoints * Math.abs(t.delta) * t.units * t.lots;
  return {
    pnl,
    rResult: rupeeR && rupeeR > 0 ? pnl / rupeeR : undefined,
    optionPct: t.premium > 0 ? ((t.exitPremium - t.premium) / t.premium) * 100 : 0,
    heldMinutes: Math.max(0, Math.round((t.exitedAt - t.enteredAt) / 60_000)),
    reached: { tp1: has(t.events, "tp1"), tp2: has(t.events, "tp2"), stop: has(t.events, "stop"), cap: has(t.events, "cap") },
  };
}

/** The reason to suggest when the trader exits: what the screen saw happen, else the clock, else by hand. */
export function suggestedReason(view: TradeView): TradeExitReason {
  if (view.status === "stopped") return "stop";
  if (view.status === "tp2") return "tp2";
  if (view.capHit) return "cap";
  if (view.timeStop.state !== "before") return "time";
  if (view.stopAtEntry) return "tp1";
  return "manual";
}

/** The gauge of the result in R: -1R (the stop) to +2R (TP2), as 0..1 along the bar, clamped. */
export const gaugePosition = (rMultiple: number) => Math.max(0, Math.min(1, (rMultiple + 1) / 3));
