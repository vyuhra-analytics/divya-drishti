// The sources that follow the Fetcher contract (fetcher.ts), plus a registry of every external source we use.
// Each fetcher is plain data and functions: the API controllers only validate the query and call the runner.
import { CHOKEPOINT_PORTNAME, parseTransits, type ChokepointId, type TransitDay } from "./chokepoints";
import { COT_DATASET, COT_MARKETS, parseCot, type CotMarketId, type CotRow } from "./cot";
import { curveCodes, curveInstruments, parseCurve, type CurvePoint } from "./curve";
import type { Fetcher } from "./fetcher";
import { JODI_COUNTRIES, parseJodi, type JodiPoint } from "./jodi";

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
      headers: { "Content-Type": "application/json", Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({ symbols: { tickers: curveCodes(inst.root, io.now(), 12) }, columns: ["close", "volume", "expiration"] }),
      signal: timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  transform: (raw, _q, io) => parseCurve(raw, io.now()),
  isUsable: (pts) => pts.length >= 2, // a curve needs two contracts
};

// ---- JODI Oil World (annual CSVs, keyless) -> JodiPoint[]
const JODI_BASE = "https://www.jodidata.org/_resources/files/downloads/oil-data/annual-csv/primary";
export const jodiFetcher: Fetcher<Record<string, never>, string[], JodiPoint[]> = {
  id: "jodi",
  label: "JODI Oil World",
  website: "https://www.jodidata.org",
  ttlMs: 12 * HOUR, // monthly data
  key: () => "all",
  async extract(_q, io) {
    // the current year's file is primaryyear{Y}.csv and earlier years {Y}.csv: try both so a rename does not break us. Never the 285 MB all-world file.
    const y = new Date(io.now()).getUTCFullYear();
    const year = async (n: number) => {
      for (const name of [`${n}`, `primaryyear${n}`]) {
        const res = await io.fetch(`${JODI_BASE}/${name}.csv`, { signal: timeout(60_000) }).catch(() => null);
        if (res?.ok) return res.text();
      }
      return "";
    };
    return Promise.all([year(y - 1), year(y)]);
  },
  transform: (texts) => texts.flatMap((t) => parseJodi(t, JODI_COUNTRIES.map((c) => c.code))),
  isUsable: (points) => points.length > 0,
};

/** Every external source we depend on, with what it needs: for docs now, and for canaries and a data-quality console later. */
export const SOURCES = [
  { id: "upstox", label: "Upstox", website: "https://upstox.com", kind: "prices, history, options, positions", credentials: ["UPSTOX_ACCESS_TOKEN or login"], fetcher: false },
  { id: "tradingview", label: "TradingView scanner", website: "https://www.tradingview.com", kind: "prices, options, curve", credentials: [], fetcher: "tv-curve (curve only)" },
  { id: "yahoo", label: "Yahoo Finance", website: "https://finance.yahoo.com", kind: "NYMEX prices and history", credentials: [], fetcher: false },
  { id: "cftc-cot", label: "CFTC positioning", website: cotFetcher.website, kind: "weekly positioning", credentials: [], fetcher: "cftc-cot" },
  { id: "imf-portwatch", label: "IMF PortWatch", website: chokepointFetcher.website, kind: "chokepoint transits", credentials: [], fetcher: "imf-portwatch" },
  { id: "jodi", label: "JODI Oil World", website: jodiFetcher.website, kind: "country oil balances", credentials: [], fetcher: "jodi" },
  { id: "eia", label: "EIA open data", website: "https://www.eia.gov/opendata/", kind: "weekly stocks, spot prices", credentials: ["EIA_API_KEY"], fetcher: false },
  { id: "eia-csv", label: "EIA weekly CSVs", website: "https://ir.eia.gov", kind: "calendar actuals", credentials: [], fetcher: false },
  { id: "fred", label: "FRED", website: "https://fred.stlouisfed.org", kind: "calendar actuals (US macro)", credentials: [], fetcher: false },
  { id: "forex-factory", label: "Forex Factory calendar", website: "https://nfs.faireconomy.media", kind: "forecast and previous", credentials: [], fetcher: false },
  { id: "sec-edgar", label: "SEC EDGAR", website: "https://www.sec.gov", kind: "insider trades", credentials: ["SEC_EDGAR_CONTACT"], fetcher: false },
  { id: "rss", label: "News feeds (Google News, OilPrice, CNBC...)", website: "", kind: "headlines", credentials: [], fetcher: false },
  { id: "anthropic", label: "Anthropic API", website: "https://www.anthropic.com", kind: "AI briefing", credentials: ["ANTHROPIC_API_KEY"], fetcher: false },
] as const;
