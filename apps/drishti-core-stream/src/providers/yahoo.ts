import type { Instrument, Quote } from "@drishti/shared";
import { getJson, poll, type Emit, type ProviderStats } from "./provider";

// Yahoo Finance chart endpoint (unofficial, no key). CME futures here are ~10 min delayed.
const BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0 Safari/537.36" };
const POLL_MS = 5000;

export function parseChartQuote(json: any, inst: Instrument): Quote | null {
  const m = json?.chart?.result?.[0]?.meta;
  if (typeof m?.regularMarketPrice !== "number") return null;
  return {
    symbol: inst.symbol,
    price: m.regularMarketPrice,
    time: m.regularMarketTime * 1000,
    prevClose: m.chartPreviousClose ?? undefined,
    high: m.regularMarketDayHigh ?? undefined,
    low: m.regularMarketDayLow ?? undefined,
    volume: m.regularMarketVolume ?? undefined,
    source: "yahoo",
    delayedBy: inst.delayedBy,
  };
}

export function startYahoo(instruments: Instrument[], emit: Emit, stats: ProviderStats) {
  return poll(POLL_MS, stats, async () => {
    const results = await Promise.allSettled(
      instruments.map(async (inst) => {
        const json = await getJson(`${BASE}${encodeURIComponent(inst.yahoo!)}?interval=1m&range=1d`, { headers: HEADERS });
        const q = parseChartQuote(json, inst);
        if (q) emit(q);
      }),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  });
}
