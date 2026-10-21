import { ENERGY_UNIVERSE, parseUniverseScan, UNIVERSE_COLUMNS, type UniverseRow } from "@drishti/shared";
import { getJson, newStats, poll } from "./providers/provider";

// Energy universe (heatmap / screener) from TradingView's scanner, polled here once for all clients.
const URL = "https://scanner.tradingview.com/global/scan";
const HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36",
};
const POLL_MS = 10_000;

export const universeStats = newStats();
const rows = new Map<string, UniverseRow>();
export const currentUniverse = () => [...rows.values()];

/**
 * `mcxTicker(root)` resolves an MCX root (MCX:CRUDEOIL) to the traded dated contract (MCX:CRUDEOILX2026), because
 * TradingView's MCX `1!` rolls late. `publish` gets only rows whose values changed.
 */
export function startUniverse(mcxTicker: (root: string) => string, publish: (changed: UniverseRow[]) => void) {
  return poll(POLL_MS, universeStats, async () => {
    const toScan = new Map(ENERGY_UNIVERSE.map((u) => [u.tv.startsWith("MCX:") ? mcxTicker(u.tv) : u.tv, u.tv]));
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
