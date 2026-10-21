import { userAgentFor } from "@drishti/shared";
import type { Instrument, Quote } from "@drishti/shared";
import { getJson, poll, type Emit, type ProviderStats } from "./provider";

// Public scanner endpoint behind tradingview.com's own screener. Unofficial: fallback only.
const URL = "https://scanner.tradingview.com/global/scan";
const HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
  "User-Agent": userAgentFor("scanner.tradingview.com"),
};
const COLUMNS = ["close", "open", "high", "low", "volume", "change", "update_mode", "bid", "ask", "open_interest", "VWAP"] as const;
const POLL_MS = 2000;

/** Scanner rows → quotes. `targets` maps TradingView ticker → our instrument (+ contract label). */
export function parseScan(
  json: any,
  targets: Map<string, { inst: Instrument; contract?: string }>,
  now: number,
): Quote[] {
  const out: Quote[] = [];
  for (const row of json?.data ?? []) {
    const t = targets.get(row.s);
    const [close, open, high, low, volume, change, mode, bid, ask, oi, vwapToday] = (row.d ?? []).map((v: unknown) =>
      typeof v === "number" || typeof v === "string" ? v : undefined,
    );
    const n = (v: unknown) => (typeof v === "number" ? v : undefined);
    if (!t || typeof close !== "number") continue;
    // "delayed_streaming_600" → 600 s behind the exchange
    const delayedBy = Number(/delayed_streaming_(\d+)/.exec(mode ?? "")?.[1] ?? 0);
    out.push({
      symbol: t.inst.symbol,
      price: close,
      time: now - delayedBy * 1000,
      prevClose: typeof change === "number" ? +(close / (1 + change / 100)).toFixed(t.inst.decimals + 2) : undefined,
      open: open ?? undefined,
      high: high ?? undefined,
      low: low ?? undefined,
      volume: volume ?? undefined,
      bid: n(bid),
      ask: n(ask),
      oi: n(oi),
      atp: n(vwapToday),
      contract: t.contract,
      source: "tradingview",
      delayedBy,
    });
  }
  return out;
}

export function startTradingView(
  targets: () => Map<string, { inst: Instrument; contract?: string }>,
  emit: Emit,
  stats: ProviderStats,
) {
  return poll(POLL_MS, stats, async () => {
    const t = targets();
    const json = await getJson(URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ symbols: { tickers: [...t.keys()] }, columns: COLUMNS }),
    });
    parseScan(json, t, Date.now()).forEach(emit);
  });
}
