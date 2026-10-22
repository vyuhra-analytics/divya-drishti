// The sources that follow the Fetcher contract (fetcher.ts), plus a registry of every external source we use.
// Each fetcher is plain data and functions: the API controllers only validate the query and call the runner.
import { CHOKEPOINT_PORTNAME, parseTransits, type ChokepointId, type TransitDay } from "./chokepoints";
import { COT_DATASET, COT_MARKETS, parseCot, type CotMarketId, type CotRow } from "./cot";
import { curveCodes, curveInstruments, parseCurve, type CurvePoint } from "./curve";
import type { Fetcher } from "./fetcher";
import { userAgentFor } from "./userAgents";

const HOUR = 3600_000;
const timeout = (ms: number) => AbortSignal.timeout(ms);

// ---- CFTC Commitments of Traders (Socrata, keyless) -> CotRow[]
const COT_FIELDS = [
  "report_date_as_yyyy_mm_dd", "open_interest_all", "change_in_open_interest_all",
  "m_money_positions_long_all", "m_money_positions_short_all", "m_money_positions_spread", "change_in_m_money_long_all", "change_in_m_money_short_all", "traders_m_money_long_all", "traders_m_money_short_all",
  "prod_merc_positions_long", "prod_merc_positions_short", "change_in_prod_merc_long", "change_in_prod_merc_short", "traders_prod_merc_long_all", "traders_prod_merc_short_all",
  "swap_positions_long_all", "swap__positions_short_all", "change_in_swap_long_all", "change_in_swap_short_all", "traders_swap_long_all", "traders_swap_short_all",
  "other_rept_positions_long", "other_rept_positions_short", "change_in_other_rept_long", "change_in_other_rept_short", "traders_other_rept_long_all", "traders_other_rept_short",
  "nonrept_positions_long_all", "nonrept_positions_short_all", "change_in_nonrept_long_all", "change_in_nonrept_short_all",
].join(",");

export const cotFetcher: Fetcher<{ market: CotMarketId; weeks: number }, any[], CotRow[]> = {
  id: "cftc-cot",
  label: "CFTC positioning",
  website: "https://publicreporting.cftc.gov",
  ttlMs: HOUR, // weekly data, published Fridays
  key: (q) => `${q.market}|${q.weeks}`,
  async extract(q, io) {
    const m = COT_MARKETS.find((x) => x.id === q.market)!; // the contract code comes from our table, never from the caller
    const url = new URL(`https://publicreporting.cftc.gov/resource/${COT_DATASET}.json`);
    url.searchParams.set("$select", COT_FIELDS);
    url.searchParams.set("$where", `cftc_contract_market_code='${m.code}'`);
    url.searchParams.set("$order", "report_date_as_yyyy_mm_dd DESC");
    url.searchParams.set("$limit", String(q.weeks));
    const res = await io.fetch(url, { headers: { Accept: "application/json" }, signal: timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as any[];
  },
  transform: (raw) => parseCot(raw),
  isUsable: (rows) => rows.length > 0,
};

// ---- IMF PortWatch chokepoint transits (ArcGIS, keyless) -> TransitDay[]
export const chokepointFetcher: Fetcher<{ id: ChokepointId }, unknown, TransitDay[]> = {
  id: "imf-portwatch",
  label: "IMF PortWatch",
  website: "https://portwatch.imf.org",
  ttlMs: HOUR, // updated weekly, a few days behind
  key: (q) => q.id,
  async extract(q, io) {
    const url = new URL("https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query");
    url.searchParams.set("where", `portname='${CHOKEPOINT_PORTNAME[q.id]}'`); // name from our own table
    url.searchParams.set("outFields", "date,n_tanker,n_total,capacity_tanker");
    url.searchParams.set("orderByFields", "date DESC");
    url.searchParams.set("resultRecordCount", "1000"); // the service's page size: ~2.7 years, enough for a year-ago comparison
    url.searchParams.set("f", "json");
    const res = await io.fetch(url, { signal: timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  transform: (raw) => parseTransits(raw),
  isUsable: (days) => days.length > 0,
};

// ---- TradingView futures curve (public scanner, keyless) -> CurvePoint[]
export const curveFetcher: Fetcher<{ symbol: string }, unknown, CurvePoint[]> = {
  id: "tv-curve",
  label: "TradingView futures curve",
  website: "https://www.tradingview.com",
  ttlMs: 10_000,
  key: (q) => q.symbol,
  async extract(q, io) {
    const inst = curveInstruments().find((i) => i.symbol === q.symbol)!;
    const res = await io.fetch("https://scanner.tradingview.com/global/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/", "User-Agent": userAgentFor("scanner.tradingview.com") },
      body: JSON.stringify({ symbols: { tickers: curveCodes(inst.root, io.now(), 12) }, columns: ["close", "volume", "expiration"] }),
      signal: timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  transform: (raw, _q, io) => parseCurve(raw, io.now()),
  isUsable: (pts) => pts.length >= 2, // a curve needs two contracts
};

export type SourceRisk = "low" | "medium" | "high";

export interface SourceInfo {
  id: string;
  label: string;
  website: string;
  kind: string;
  credentials: readonly string[];
  /** the Fetcher that serves it, when it follows the contract */
  fetcher: string | false;
  /** how likely the source is to throttle or block us: official and authenticated feeds are low, unofficial public endpoints medium, ones that already throttle us high */
  risk: SourceRisk;
  /** "auto": may be used as a fallback without asking. "explicit": only when the user turns it on, because it would show a misleading series or costs money */
  fallback: "auto" | "explicit";
  /** why, in a line */
  note: string;
}

/** Every external source we depend on, with what it needs, how risky it is and whether it may be a silent fallback: for docs, canaries (high-risk sources are probed less often) and the data-quality console. */
export const SOURCES: readonly SourceInfo[] = [
  { id: "upstox", label: "Upstox", website: "https://upstox.com", kind: "prices, history, options, positions", credentials: ["UPSTOX_ACCESS_TOKEN or login"], fetcher: false, risk: "low", fallback: "auto", note: "your own authenticated broker feed" },
  { id: "tradingview", label: "TradingView scanner", website: "https://www.tradingview.com", kind: "prices, options, curve", credentials: [], fetcher: "tv-curve (curve only)", risk: "medium", fallback: "auto", note: "unofficial public endpoint; dated MCX contracts only" },
  { id: "tradingview-mcx-continuous", label: "TradingView MCX continuous (1!)", website: "https://www.tradingview.com", kind: "MCX prices by continuous code", credentials: [], fetcher: false, risk: "medium", fallback: "explicit", note: "rolls late, so in the last days before expiry it shows the wrong contract: enable with TV_MCX_CONTINUOUS=1 if you accept that" },
  { id: "yahoo", label: "Yahoo Finance", website: "https://finance.yahoo.com", kind: "NYMEX prices and history", credentials: [], fetcher: false, risk: "medium", fallback: "auto", note: "unofficial, 10 minutes delayed; its continuous history has roll jumps" },
  { id: "cftc-cot", label: "CFTC positioning", website: cotFetcher.website, kind: "weekly positioning", credentials: [], fetcher: "cftc-cot", risk: "low", fallback: "auto", note: "official government data" },
  { id: "imf-portwatch", label: "IMF PortWatch", website: chokepointFetcher.website, kind: "chokepoint transits", credentials: [], fetcher: "imf-portwatch", risk: "low", fallback: "auto", note: "official public dataset" },
  { id: "eia", label: "EIA open data", website: "https://www.eia.gov/opendata/", kind: "weekly stocks, spot prices", credentials: ["EIA_API_KEY"], fetcher: false, risk: "low", fallback: "auto", note: "official API with a free key; the shared DEMO_KEY is never used" },
  { id: "eia-csv", label: "EIA weekly CSVs", website: "https://ir.eia.gov", kind: "calendar actuals", credentials: [], fetcher: false, risk: "low", fallback: "auto", note: "official files" },
  { id: "fred", label: "FRED", website: "https://fred.stlouisfed.org", kind: "calendar actuals (US macro)", credentials: [], fetcher: false, risk: "low", fallback: "auto", note: "official keyless CSV" },
  { id: "forex-factory", label: "Forex Factory calendar", website: "https://nfs.faireconomy.media", kind: "forecast and previous", credentials: [], fetcher: false, risk: "high", fallback: "auto", note: "answers HTTP 429 after a few requests: cached 30 minutes, last good copy kept, 5-minute back-off" },
  { id: "rss", label: "News feeds (Google News, OilPrice, CNBC...)", website: "", kind: "headlines", credentials: [], fetcher: false, risk: "medium", fallback: "auto", note: "public feeds, polled every 1 to 5 minutes; Google News is the most likely to throttle" },
  { id: "anthropic", label: "Anthropic API", website: "https://www.anthropic.com", kind: "AI briefing", credentials: ["ANTHROPIC_API_KEY"], fetcher: false, risk: "low", fallback: "explicit", note: "costs money: only ever called when you press the button, never as a silent fallback" },
];

/** How much longer than its normal interval a source is left alone between canary probes. */
export const CANARY_SPACING: Record<SourceRisk, number> = { low: 1, medium: 2, high: 6 };

/** Registry entry for a source id. */
export const sourceInfo = (id: string) => SOURCES.find((s) => s.id === id);

/** Canary interval for a sample: its own interval (default hourly) stretched by the risk of the source behind it. */
export function canaryInterval(sourceId: string, baseMs: number): number {
  return baseMs * CANARY_SPACING[sourceInfo(sourceId)?.risk ?? "medium"];
}
