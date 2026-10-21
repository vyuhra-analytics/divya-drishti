import { useCallback, useEffect, useRef, useState } from "react";
import type { Chain } from "@drishti/shared";
import { apiUrl } from "./settings";

export type ChainFeed = "auto" | "upstox" | "tradingview";

const POLL_MS = 3000;
const POLL_TV_MS = 1000; // TradingView streams the chain in real time, and the API shares one fetch per second

/**
 * One option chain from the API, kept current while the tab is visible: every second on the TradingView-based feeds, every 3 s on
 * Upstox alone. A different underlying forgets the expiry; `reload` forces a read now.
 */
export function useChain(underlying: string, expiry: string, feed: ChainFeed, strikes: number) {
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tv = chain?.source === "tradingview" || chain?.source === "combined";
  const reloadRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    setChain(null);
  }, [underlying]);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const load = async () => {
      if (document.hidden) return; // don't poll Upstox for a hidden tab
      try {
        const res = await fetch(`${apiUrl()}/options?underlying=${underlying}&source=${feed}&strikes=${strikes}${expiry ? `&expiry=${expiry}` : ""}`, { signal: ctrl.signal });
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
        setChain(json);
        setError(null);
      } catch (e) {
        if (alive && (e as Error).name !== "AbortError") setError((e as Error).message);
      }
    };
    reloadRef.current = () => void load();
    void load();
    const id = setInterval(load, tv ? POLL_TV_MS : POLL_MS);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(id);
    };
  }, [underlying, expiry, feed, strikes, tv]);

  return { chain, error, reload: useCallback(() => reloadRef.current(), []) };
}
