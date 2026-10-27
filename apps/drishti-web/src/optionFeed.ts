import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Chain, OptionLeg, OptionQuote } from "@drishti/shared";
import { sendWatch, useStore } from "./store";
import { useNow } from "./market";

// Live option quotes from the stream (Upstox feed, about one a second per contract) laid over the HTTP chain, which stays the fallback:
// a leg takes the live values only while its last quote is fresh, so a silent feed shows the polled numbers again within seconds.

/** a live quote older than this is not shown over the polled chain */
export const LIVE_MAX_AGE_MS = 10_000;
/** how many contracts each side of the money a chain asks to watch (4 strikes each side, calls and puts = 18 contracts) */
export const WATCH_STRIKES = 4;
const REWATCH_MS = 20_000; // the stream drops a contract nobody has asked for in 60 s

/** The Upstox keys to watch: the legs of the strikes around the money. */
export function watchKeys(chain: Chain | null | undefined, span = WATCH_STRIKES): string[] {
  if (!chain?.rows.length) return [];
  const at = chain.atm ?? chain.spot ?? chain.rows[Math.floor(chain.rows.length / 2)].strike;
  const nearest = [...chain.rows].sort((a, b) => Math.abs(a.strike - at) - Math.abs(b.strike - at)).slice(0, span * 2 + 1);
  return nearest.flatMap((r) => [r.ce?.ukey, r.pe?.ukey]).filter((k): k is string => !!k);
}

const overlay = (leg: OptionLeg | undefined, q: OptionQuote | undefined, now: number): OptionLeg | undefined => {
  if (!leg || !q || now - q.recvAt > LIVE_MAX_AGE_MS) return leg;
  return {
    ...leg,
    ltp: q.price,
    bid: q.bid ?? leg.bid,
    ask: q.ask ?? leg.ask,
    oi: q.oi ?? leg.oi,
    volume: q.volume ?? leg.volume,
    iv: q.iv ?? leg.iv,
    delta: q.delta ?? leg.delta,
    theta: q.theta ?? leg.theta,
    gamma: q.gamma ?? leg.gamma,
    vega: q.vega ?? leg.vega,
  };
};

export interface LiveSummary {
  /** contracts asked for */
  watched: number;
  /** of those, with a quote fresher than LIVE_MAX_AGE_MS */
  fresh: number;
  /** age in ms of the newest quote, undefined when none has arrived */
  newestAgeMs?: number;
}

/** Pure: the chain with fresh live quotes laid over its legs, and how many legs are live. */
export function overlayLive(chain: Chain, quotes: Record<string, OptionQuote>, now: number): { chain: Chain; live: LiveSummary } {
  const keys = watchKeys(chain);
  const ages = keys.map((k) => (quotes[k] ? now - quotes[k].recvAt : undefined)).filter((a): a is number => a !== undefined);
  const live: LiveSummary = { watched: keys.length, fresh: ages.filter((a) => a <= LIVE_MAX_AGE_MS).length, newestAgeMs: ages.length ? Math.min(...ages) : undefined };
  if (!live.fresh) return { chain, live };
  const rows = chain.rows.map((r) => ({ ...r, ce: overlay(r.ce, r.ce?.ukey ? quotes[r.ce.ukey] : undefined, now), pe: overlay(r.pe, r.pe?.ukey ? quotes[r.pe.ukey] : undefined, now) }));
  return { chain: { ...chain, rows }, live };
}

/**
 * Asks the stream for the contracts around the money (now and every 20 s, and again after a reconnect) and returns the chain with
 * fresh live quotes laid over it. With no live quote the polled chain comes back untouched.
 */
export function useLiveChain(polled: Chain | null): { chain: Chain | null; live: LiveSummary } {
  const epoch = useStore((s) => s.epoch); // +1 on every (re)connect: the new socket has no watch list yet
  const now = useNow(1000);
  const keys = useMemo(() => watchKeys(polled).join(","), [polled]);
  // only the watched contracts: the store holds every option the stream sends (hundreds), and the other ones must not redraw the chain
  const quotes = useStore(useShallow((s) => Object.fromEntries(keys.split(",").filter(Boolean).map((k) => [k, s.options[k]]))));
  useEffect(() => {
    if (!keys) return;
    const list = keys.split(",");
    sendWatch(list);
    const id = setInterval(() => sendWatch(list), REWATCH_MS);
    return () => clearInterval(id);
  }, [keys, epoch]);
  return useMemo(() => (polled ? overlayLive(polled, quotes, now) : { chain: null, live: { watched: 0, fresh: 0 } }), [polled, quotes, now]);
}
