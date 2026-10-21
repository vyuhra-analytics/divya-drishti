import { useEffect, useState } from "react";
import { freshness, instrument, mcxSession, nymexSession, type DayOverride, type Freshness, type SessionState } from "@drishti/shared";
import { useStore } from "./store";
import { apiUrl } from "./settings";

/** Re-render every `ms` so time-based state (session boundaries, ages) stays current without new data. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// Today's official MCX window from Upstox (via the API), shared by every component; refreshed every 30 min.
let mcxToday: DayOverride | undefined;
let lastFetch = 0;
async function refreshCalendar() {
  if (Date.now() - lastFetch < 30 * 60_000) return;
  lastFetch = Date.now();
  try {
    const res = await fetch(`${apiUrl()}/market/sessions`);
    const json = await res.json();
    mcxToday = json?.mcx ?? undefined; // null = unknown → weekday rule
  } catch {
    lastFetch = 0; // retry on the next tick
  }
}

/** MCX and NYMEX open/closed with the next boundary, recomputed every 15 s. */
export function useSessions(): { MCX: SessionState; NYMEX: SessionState } {
  const now = useNow();
  useEffect(() => void refreshCalendar(), [now]);
  return { MCX: mcxSession(now, mcxToday), NYMEX: nymexSession(now) };
}

/** live / stale / closed for one symbol: exchange session + when its source was last heard from (server heartbeat). */
export function useFreshness(symbol: string): Freshness {
  const sessions = useSessions();
  const seen = useStore((s) => s.seen[symbol]);
  const exchange = instrument(symbol)?.exchange;
  return freshness(exchange ? sessions[exchange].open : true, seen, Date.now());
}

/** Non-hook version of `useFreshness` for code that runs outside React: live / stale / closed for this symbol right now. */
export function symbolFreshness(symbol: string, now = Date.now()): Freshness {
  const exchange = instrument(symbol)?.exchange;
  const open = exchange === "MCX" ? mcxSession(now, mcxToday).open : exchange === "NYMEX" ? nymexSession(now).open : true;
  return freshness(open, useStore.getState().seen[symbol], now);
}

/** Is this symbol's exchange open and its feed live right now? */
export const isLive = (symbol: string, now = Date.now()) => symbolFreshness(symbol, now) === "live";
