// The option leg of a signal. The strategies read their signal on the FUTURE (a 5-minute close beyond the range, R from the future's ATR) but trade a BOUGHT
// option: a call for a long, a put for a short, one lot. This turns the future's levels into the option's: the strike is the screen's own pick (`suggestStrike`:
// at the money with |delta| 0.5 or more, else the strike nearest 0.6 delta, only one that fits the capital and whose 1R stays inside the loss cap), the entry is
// its ask, and the premium levels are the future's R, TP1 and TP2 distances times the delta read at that moment, fixed there. Buy only. Pure and tested.
import type { Chain } from "./options";
import { suggestStrike, type DaySide } from "./reportDay";

export interface SignalFutureLevels {
  side: DaySide;
  entry?: number;
  rPoints?: number;
  tp2?: number;
  /** USIB: the trail after TP2, in future points */
  trail?: number;
}

export interface OptionLegSignal {
  /** the Upstox instrument key, to follow its quote and to place the order */
  key?: string;
  label: string;
  type: "CE" | "PE";
  strike: number;
  expiry: string;
  /** units per lot (one lot is traded) */
  units: number;
  /** the ask the levels start from, the delta read with it, and the cost of one lot */
  premium: number;
  delta: number;
  cost: number;
  /** 1R on the option: the future's R times |delta|, in premium points and in rupees for one lot */
  rPremium: number;
  rupeeR: number;
  stop: number;
  tp1: number;
  tp2: number;
  /** USIB: the premium trail after TP2 (the future's trail times |delta|) */
  trail?: number;
  /** where the premium and delta came from, in words (a live chain, a recorded snapshot...) */
  basis?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The option to buy for a future signal, with its premium levels, or the reason there is none. `underlying` names the contract in the label. The chain must be
 * of the expiry to trade (the nearest for crude, the next for gas: the caller chooses).
 */
export function optionLegFor(signal: SignalFutureLevels, chain: Chain | null | undefined, underlying: string): { leg?: OptionLegSignal; reason: string } {
  if (signal.rPoints === undefined || !(signal.rPoints > 0)) return { reason: "the signal has no R yet (not enough candles for the ATR)" };
  const s = suggestStrike(chain, signal.side, signal.rPoints);
  const p = s.pick;
  if (!p || !chain) return { reason: s.note };
  const rPremium = signal.rPoints * p.delta;
  const stop = p.premium - rPremium;
  if (!(stop > 0)) return { reason: `1R on the option (${r2(rPremium)}) is as large as its premium (${r2(p.premium)}): no stop can be set under it` };
  const tp2Points = signal.entry !== undefined && signal.tp2 !== undefined ? Math.abs(signal.tp2 - signal.entry) : 2 * signal.rPoints;
  const type = signal.side === "long" ? "CE" : "PE";
  return {
    reason: s.note,
    leg: {
      ...(p.key ? { key: p.key } : {}),
      label: `${underlying} ${p.strike} ${type} ${chain.expiry}`,
      type,
      strike: p.strike,
      expiry: chain.expiry,
      units: chain.lot ?? 1,
      premium: r2(p.premium),
      delta: r2(p.delta),
      cost: Math.round(p.cost),
      rPremium: r2(rPremium),
      rupeeR: Math.round(p.rupeeR ?? rPremium * (chain.lot ?? 1)),
      stop: r2(stop),
      tp1: r2(p.premium + rPremium),
      tp2: r2(p.premium + tp2Points * p.delta),
      ...(signal.trail !== undefined ? { trail: r2(signal.trail * p.delta) } : {}),
    },
  };
}
