import { FX_COLUMNS, FX_PAIRS, parseFxScan, userAgentFor, type FxRow } from "@drishti/shared";
import { getJson, newStats, poll } from "./providers/provider";

// Currency pairs (USD/INR) from TradingView's public scanner, polled once here for every client.
const URL = "https://scanner.tradingview.com/global/scan";
const HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
  "User-Agent": userAgentFor("scanner.tradingview.com"),
};
const POLL_MS = 5_000;

export const fxStats = newStats();
const rows = new Map<string, FxRow>();
export const currentFx = () => [...rows.values()];

/** `publish` gets every row on every successful poll (a few bytes every 5 s), so clients can tell "unchanged" from "feed stopped" by the row's time. */
export function startFx(publish: (changed: FxRow[]) => void) {
  return poll(POLL_MS, fxStats, async () => {
    const json = await getJson(URL, { method: "POST", headers: HEADERS, body: JSON.stringify({ symbols: { tickers: FX_PAIRS.map((p) => p.tv) }, columns: FX_COLUMNS }) });
    const fresh = parseFxScan(json, Date.now());
    for (const r of fresh) rows.set(r.id, r);
    if (fresh.length) publish(fresh);
  });
}
