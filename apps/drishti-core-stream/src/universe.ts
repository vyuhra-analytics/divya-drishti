import { userAgentFor } from "@drishti/shared";
import { ENERGY_UNIVERSE, parseUniverseScan, UNIVERSE_COLUMNS, type UniverseRow } from "@drishti/shared";
import { getJson, newStats, poll } from "./providers/provider";

// Energy universe (heatmap / screener) from TradingView's scanner, polled here once for all clients.
const URL = "https://scanner.tradingview.com/global/scan";
const HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
  "User-Agent": userAgentFor("scanner.tradingview.com"),
};
const POLL_MS = 10_000;

export const universeStats = newStats();
const rows = new Map<string, UniverseRow>();
export const currentUniverse = () => [...rows.values()];

/**
 * `mcxTicker(root)` resolves an MCX root (MCX:CRUDEOIL) to the traded dated contract (MCX:CRUDEOILX2026), because
 * TradingView's MCX `1!` rolls late. `publish` gets only rows whose values changed.
 */
export function startUniverse(mcxTicker: (root: string) => string | undefined, publish: (changed: UniverseRow[]) => void) {
  return poll(POLL_MS, universeStats, async () => {
    // an MCX root with no known front month is left out (its continuous code would show the wrong contract)
    const toScan = new Map(ENERGY_UNIVERSE.flatMap((u): [string, string][] => {
      const ticker = u.tv.startsWith("MCX:") ? mcxTicker(u.tv) : u.tv;
      return ticker ? [[ticker, u.tv]] : [];
    }));
    const json = await getJson(URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ symbols: { tickers: [...toScan.keys()] }, columns: UNIVERSE_COLUMNS }),
    });
    const changed = parseUniverseScan(json, (s) => toScan.get(s)).filter((r) => {
      const prev = rows.get(r.tv);
      const same = prev && prev.price === r.price && prev.changePct === r.changePct && prev.volume === r.volume;
      rows.set(r.tv, r);
      return !same;
    });
    if (changed.length) publish(changed);
  });
}
