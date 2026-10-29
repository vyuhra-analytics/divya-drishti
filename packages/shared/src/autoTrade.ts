// The automatic PAPER trade of the report-day and USIB signals. The signal is read on the future, but the trade is a BOUGHT OPTION (the strategies buy calls and
// puts, one lot): when a signal fires and the switch is on, the option leg of the signal (optionSignal.ts) is bought in a separate "auto" paper account with its
// stop and target in premium held by the server, and the server also moves the stop to the entry at TP1, trails it (USIB) and closes at the time exit (the
// order's `plan`). Simulated only: nothing here can reach a broker. The pure parts are here and tested; the browser (AutoPaper.tsx) carries them out.
import type { DaySide } from "./reportDay";
import { DAY_RULES } from "./reportDay";
import type { OptionLegSignal } from "./optionSignal";
import { TIME_STOP } from "./reportTrade";

/** The paper account the automatic trades use, kept apart from the owner's own and an agent's. It starts with the strategy capital. */
export const AUTO_ACCOUNT = "auto";
export const AUTO_CAPITAL = DAY_RULES.capital;

/** A signal is acted on only this long after its candle closed: armed after that, the entry is gone and the trade is skipped, never chased. */
export const AUTO_SIGNAL_MAX_AGE_MS = 120_000;

export const signalFresh = (candleTimeSec: number, candleSec: number, now: number) => now - (candleTimeSec + candleSec) * 1000 <= AUTO_SIGNAL_MAX_AGE_MS;

/** What is kept of an automatic trade, in the browser, so a reload carries on where it was. Prices are option PREMIUMS. */
export interface AutoRecord {
  status: "placed" | "closed" | "skipped";
  /** why it was skipped, or how it closed */
  reason?: string;
  /** the option bought: its name, Upstox key and the side of the signal that chose it */
  label?: string;
  optionKey?: string;
  dir?: DaySide;
  lots?: number;
  units?: number;
  /** the premium paid (the fill), the stop the server holds now, the original stop, and the levels */
  entry?: number;
  stop?: number;
  currentStop?: number;
  tp1?: number;
  tp2?: number;
  /** 1R on the option in premium points */
  rPremium?: number;
  enteredAt?: number;
  positionId?: string;
  /** the server has moved the stop to the entry */
  tp1Done?: boolean;
  exit?: { at: number; price: number; net: number; reason: string };
}

export interface AutoOrderContext {
  strategy: "report-day" | "usib";
  /** where this release's record is kept: the order's client id is derived from it, so a reload or retry never places twice */
  recordKey: string;
  /** the signal's candle (its open, epoch seconds) */
  candleTime: number;
  /** the print (report day) or the US open (USIB), epoch ms, and the time-stop window that closes the trade */
  releaseAt: number;
  timeStop?: { fromMin: number; toMin: number };
}

/**
 * The paper order for an option leg: one lot, the stop and (report day only) the target in premium, labels for reconciling with the signal log, and the plan the
 * server carries out by itself: TP1 moves the stop to the entry, USIB's trail follows the best 5-minute close of the option after TP2, the time exit closes at the market.
 * USIB has no target: TP2 does not close the trade.
 */
export function optionOrderBody(leg: OptionLegSignal, c: AutoOrderContext) {
  const usib = c.strategy === "usib";
  return {
    option: { key: leg.key },
    side: "buy" as const,
    lots: 1,
    stop: leg.stop,
    ...(usib ? {} : { target: leg.tp2 }),
    client_order_id: `auto-${c.recordKey}`.slice(0, 64),
    tag: "auto",
    strategy: c.strategy,
    signal_time: new Date((c.candleTime + DAY_RULES.candleSec) * 1000).toISOString(),
    r_points: leg.rPremium,
    plan: {
      tp1: leg.tp1,
      close_at: new Date(c.releaseAt + (c.timeStop ?? TIME_STOP).fromMin * 60_000).toISOString(),
      ...(usib && leg.trail ? { tp2: leg.tp2, trail: leg.trail, candle_sec: DAY_RULES.candleSec } : {}),
    },
  };
}

/** How a closed auto trade is told to the trader: the server's exit reason in words (a stop after TP1 is "stopped at the entry"). */
export function closedWhy(reason: string, tp1Done: boolean): string {
  if (reason === "stop") return tp1Done ? "stopped at the entry" : "stopped out";
  if (reason === "target") return "target (TP2)";
  if (reason === "time") return "time exit";
  if (reason === "expired") return "expired";
  return reason;
}
