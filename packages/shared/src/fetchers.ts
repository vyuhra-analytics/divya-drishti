// The sources that follow the Fetcher contract (fetcher.ts), plus a registry of every external source we use.
// Each fetcher is plain data and functions: the API controllers only validate the query and call the runner.
import { parseFredCsv, parseWngsr, parseWpsr, type SeriesPoint, type Wngsr, type Wpsr } from "./actuals";
import { EIA_SERIES, parseEia, summarizeEia, type EiaSummary } from "./eia";
import { EIA_SCHEDULE_URLS, parseEiaGasSchedule, parseEiaPetroleumSchedule, type EiaScheduleException } from "./eiaSchedule";
import { parseRss, type NewsItem, type NewsTag } from "./news";
import { CHOKEPOINT_PORTNAME, parseTransits, type ChokepointId, type TransitDay } from "./chokepoints";
import { COT_DATASET, COT_MARKETS, parseCot, type CotMarketId, type CotRow } from "./cot";
import { curveCodes, curveInstruments, parseCurve, type CurvePoint } from "./curve";
import { SourceMiss, type Fetcher } from "./fetcher";
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
  transform: (raw, _q, io) => {
    const pts = parseCurve(raw, io.now());
    // the scanner answered with rows but fewer than two live contracts: this instrument is thinly listed, which is no outage (an empty answer still is one)
    if (pts.length < 2 && Array.isArray((raw as any)?.data) && (raw as any).data.length > 0) throw new SourceMiss(`only ${pts.length} live contract(s) listed`);
    return pts;
  },
  isUsable: (pts) => pts.length >= 2, // a curve needs two contracts
};

// ---- EIA weekly files and FRED series (official, keyless) -> the calendar's actuals
async function csvText(url: string, io: Parameters<Fetcher<unknown, string, unknown>["extract"]>[1]): Promise<string> {
  const res = await io.fetch(url, { signal: timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const eiaWpsrFetcher: Fetcher<Record<string, never>, string, Wpsr> = {
  id: "eia-wpsr-csv",
  label: "EIA weekly petroleum file",
  website: "https://ir.eia.gov",
  ttlMs: 30_000, // read every minute while a release is due or just out
  key: () => "table1",
  extract: (_q, io) => csvText("https://ir.eia.gov/wpsr/table1.csv", io),
  transform: (csv) => parseWpsr(csv)!, // undefined (a layout we cannot read) fails isUsable below
  isUsable: (w) => w !== undefined && Number.isFinite(w.weekEnding),
};

export const eiaGasFetcher: Fetcher<Record<string, never>, string, Wngsr> = {
  id: "eia-wngsr-csv",
  label: "EIA weekly gas storage file",
  website: "https://ir.eia.gov",
  ttlMs: 30_000,
  key: () => "wngsr",
  extract: (_q, io) => csvText("https://ir.eia.gov/ngs/wngsr.csv", io),
  transform: (csv) => parseWngsr(csv)!,
  isUsable: (w) => w !== undefined && Number.isFinite(w.weekEnding),
};

/** One FRED series by id (e.g. CPIAUCSL), the last 60 points. The id comes from our own matcher table, never from the caller. */
export const fredFetcher: Fetcher<{ seriesId: string }, string, SeriesPoint[]> = {
  id: "fred-series",
  label: "FRED",
  website: "https://fred.stlouisfed.org",
  ttlMs: 30_000,
  key: (q) => q.seriesId,
  extract: (q, io) => csvText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(q.seriesId)}`, io),
  transform: (csv) => parseFredCsv(csv),
  isUsable: (pts) => pts.length > 0,
};

/** EIA Open Data v2, one series by id from our own table (never a caller-supplied route). Needs the user's free key; the shared DEMO_KEY is never used. */
export const eiaSeriesFetcher: Fetcher<{ id: string }, unknown, EiaSummary> = {
  id: "eia-v2-series",
  label: "EIA open data",
  website: "https://www.eia.gov/opendata/",
  credentials: ["EIA_API_KEY"],
  instructions: "free key at https://www.eia.gov/opendata/",
  ttlMs: HOUR, // weekly data (spot prices daily): an hourly look is plenty, and far under EIA's limits
  key: (q) => q.id,
  async extract(q, io) {
    const s = EIA_SERIES.find((x) => x.id === q.id)!;
    const url = new URL(`https://api.eia.gov/v2/seriesid/${s.route}`);
    url.searchParams.set("api_key", io.env.EIA_API_KEY!.trim());
    url.searchParams.set("length", String(s.freq === "weekly" ? 320 : 400)); // ~6 weekly years for the five-year average, ~1.5 daily years
    const res = await io.fetch(url, { signal: timeout(90_000) }); // EIA's routes take 1 to 45 s for the same call
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  transform: (raw, q) => summarizeEia(q.id, parseEia(raw)),
  isUsable: (s) => s.latest !== undefined,
};

/** EIA's holiday exceptions for one of the two weekly reports, from its schedule page. */
export const eiaScheduleFetcher: Fetcher<{ report: "WPSR" | "WNGSR" }, string, EiaScheduleException[]> = {
  id: "eia-schedule",
  label: "EIA release schedule",
  website: "https://www.eia.gov",
  ttlMs: 24 * HOUR, // EIA changes its holiday list a few times a year
  key: (q) => q.report,
  async extract(q, io) {
    const res = await io.fetch(EIA_SCHEDULE_URLS[q.report], { signal: timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
  transform: (html, q) => (q.report === "WPSR" ? parseEiaPetroleumSchedule(html) : parseEiaGasSchedule(html)),
  isUsable: (list) => list.length > 0, // a page that lists no exception is a layout we no longer read
};

/** One news feed. Filtering to energy headlines (`strict`) is the caller's, so a feed that is up but off-topic is not read as down. */
export const rssFetcher: Fetcher<{ url: string; name: string; tags: readonly NewsTag[] }, string, NewsItem[]> = {
  id: "rss",
  label: "News feed",
  website: "",
  ttlMs: 30_000, // under the shortest poll interval (60 s)
  key: (q) => q.url,
  async extract(q, io) {
    const res = await io.fetch(q.url, { signal: timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
  transform: (xml, q) => parseRss(xml, q.name, [...q.tags]),
  isUsable: (items) => items.length > 0,
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
  { id: "yahoo", label: "Yahoo Finance", website: "https://finance.yahoo.com", kind: "NYMEX prices and history, calendar release times and actuals", credentials: [], fetcher: "yahoo-calendar (calendar only)", risk: "medium", fallback: "auto", note: "unofficial, 10 minutes delayed; its continuous history has roll jumps" },
  { id: "cftc-cot", label: "CFTC positioning", website: cotFetcher.website, kind: "weekly positioning", credentials: [], fetcher: "cftc-cot", risk: "low", fallback: "auto", note: "official government data" },
  { id: "imf-portwatch", label: "IMF PortWatch", website: chokepointFetcher.website, kind: "chokepoint transits", credentials: [], fetcher: "imf-portwatch", risk: "low", fallback: "auto", note: "official public dataset" },
  { id: "eia", label: "EIA open data", website: "https://www.eia.gov/opendata/", kind: "weekly stocks, spot prices", credentials: ["EIA_API_KEY"], fetcher: "eia-v2-series", risk: "low", fallback: "auto", note: "official API with a free key; the shared DEMO_KEY is never used" },
  { id: "eia-csv", label: "EIA weekly CSVs", website: "https://ir.eia.gov", kind: "calendar actuals", credentials: [], fetcher: "eia-wpsr-csv, eia-wngsr-csv (weekly files only)", risk: "low", fallback: "auto", note: "official files" },
  { id: "fred", label: "FRED", website: "https://fred.stlouisfed.org", kind: "calendar actuals (US macro)", credentials: [], fetcher: "fred-series", risk: "low", fallback: "auto", note: "official keyless CSV" },
  { id: "forex-factory", label: "Forex Factory calendar", website: "https://nfs.faireconomy.media", kind: "forecast and previous", credentials: [], fetcher: false, risk: "high", fallback: "auto", note: "answers HTTP 429 after a few requests: cached 30 minutes, last good copy kept, 5-minute back-off" },
  { id: "investing-forecasts", label: "Investing.com economic calendar (EIA and API forecasts)", website: "https://www.investing.com", kind: "consensus forecasts of the weekly EIA crude, gasoline and distillate changes and the API's crude change", credentials: [], fetcher: false, risk: "high", fallback: "auto", note: "unofficial and its terms forbid automated access: four event pages read a few times a day at most, everything stops for 12 hours at the first block; INVESTING_FORECASTS=off disables it" },
  { id: "finance-calendar", label: "Finance Calendar", website: "https://www.financecalendar.com", kind: "calendar release times and actuals (official publishers)", credentials: [], fetcher: "finance-calendar", risk: "medium", fallback: "auto", note: "keyless free API: 2,000 requests a day per address, a visible link to the site is required where its data is shown; consensus is empty on every event tested" },
  { id: "rss", label: "News feeds (Google News, OilPrice, CNBC...)", website: "", kind: "headlines", credentials: [], fetcher: "rss", risk: "medium", fallback: "auto", note: "public feeds, polled every 1 to 5 minutes; Google News is the most likely to throttle" },
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
