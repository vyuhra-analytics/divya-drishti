// Secondary calendar sources. Forex Factory (calendar.ts) stays the main feed; these add the figures other free sources publish for the SAME releases, each
// kept under its own name in the observation log, so two sources that disagree show up as two figures instead of one overwriting the other. A secondary
// source never creates an event: a row whose release is not already planned is dropped, so a source with odd times cannot put a stray event in the calendar.
// Pure parsing and merging; the fetching takes an injected `FetchIO`, so tests run it on recorded responses.
import { naturalKey, type ObservationIn, type PlannedEvent } from "./eventPlan";
import { SERIES, parseValue, type EventSeriesDef } from "./eventSeries";
import type { FetchIO } from "./fetcher";

export interface SourceRow {
  /** the source's display name, written on every figure: "Finance Calendar" */
  source: string;
  /** the source's own stable code for the event (a series code, an event name), matched against a series' `aliases` */
  code: string;
  title: string;
  country?: string;
  /** scheduled release time, epoch ms */
  at: number;
  forecast?: string;
  previous?: string;
  actual?: string;
}

export interface CalendarSource {
  id: string;
  name: string;
  /** shown wherever the source's figures are: a licence condition for some */
  attribution?: string;
  fetch(io: FetchIO, from: number, to: number): Promise<SourceRow[]>;
}

const DAY = 86_400_000;
const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" && v.trim().toLowerCase() !== "null" ? v.trim() : undefined);

/** The series a source row belongs to: the one whose alias for that source matches the row's code (and whose country agrees). */
export function matchSeries(sourceId: string, row: Pick<SourceRow, "code" | "country">): EventSeriesDef | undefined {
  return SERIES.find((s) => s.aliases?.[sourceId]?.test(row.code) && (!row.country || row.country === s.country));
}

/**
 * Adds each source row's figures and release time to the planned event of the same series and release, as observations under the source's name.
 * Returns the number of rows used and the number dropped (no series, or no planned event for that release).
 */
export function mergeSourceRows(planned: PlannedEvent[], sourceId: string, rows: SourceRow[]): { used: number; dropped: number } {
  let used = 0;
  let dropped = 0;
  for (const row of rows) {
    const series = matchSeries(sourceId, row);
    const target = series && planned.find((p) => p.series.code === series.code && p.key === naturalKey(series, row.at));
    if (!series || !target) {
      dropped++;
      continue;
    }
    const add = (kind: ObservationIn["kind"], value: string | undefined) => {
      if (value !== undefined && !target.observations.some((o) => o.kind === kind && o.text === value && o.source === row.source)) target.observations.push({ kind, text: value, ...parseValue(value), source: row.source });
    };
    add("forecast", row.forecast);
    add("previous", row.previous);
    add("actual", row.actual);
    const at = new Date(row.at).toISOString();
    if (!target.observations.some((o) => o.kind === "release_time" && o.text === at && o.source === row.source)) target.observations.push({ kind: "release_time", text: at, num: row.at, source: row.source });
    used++;
  }
  return { used, dropped };
}

// ---- Finance Calendar (financecalendar.com): keyless, official publishers (BLS, EIA, Census, Treasury, Fed); free use needs a visible link to the site

export const FINANCE_CALENDAR_ATTRIBUTION = "Calendar data: financecalendar.com";

/** Rows of `/wp-json/fc/v1/calendar`: the series code is its stable id, the release time is given in UTC. Rows without a release time are skipped. */
export function parseFinanceCalendar(json: any): SourceRow[] {
  const events: any[] = Array.isArray(json?.events) ? json.events : [];
  return events.flatMap((e): SourceRow[] => {
    const at = Date.parse(e?.release_at_utc ?? "");
    const code = text(e?.series_code);
    if (!Number.isFinite(at) || !code) return [];
    return [{ source: "Finance Calendar", code, title: String(e.title ?? code), country: text(e.country), at, forecast: text(e.consensus), previous: text(e.prior), actual: text(e.actual) }];
  });
}

export const financeCalendar: CalendarSource = {
  id: "financecalendar",
  name: "Finance Calendar",
  attribution: FINANCE_CALENDAR_ATTRIBUTION,
  async fetch(io, from, to) {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const res = await io.fetch(`https://www.financecalendar.com/wp-json/fc/v1/calendar?from=${day(from)}&to=${day(to)}&country=US`);
    if (!res.ok) throw new Error(`Finance Calendar HTTP ${res.status}`);
    return parseFinanceCalendar(await res.json());
  },
};

// ---- Yahoo Finance's economic calendar: keyless, unofficial (the endpoint the yfinance library uses); needs a cookie and a crumb from Yahoo first

const YAHOO_COLUMNS = ["econ_release", "country_code", "startdatetime", "period", "after_release_actual", "consensus_estimate", "prior_release_actual", "originally_reported_actual"];

/** The visualization response: columns by id, rows as arrays in column order. Yahoo's consensus column is read, though it was empty on every event tested. */
export function parseYahooCalendar(json: any): SourceRow[] {
  const doc = json?.finance?.result?.[0]?.documents?.[0];
  const cols: string[] = Array.isArray(doc?.columns) ? doc.columns.map((c: any) => c?.id) : [];
  const idx = (id: string) => cols.indexOf(id);
  const [iName, iCountry, iAt, iActual, iExpected, iPrior] = ["econ_release", "country_code", "startdatetime", "after_release_actual", "consensus_estimate", "prior_release_actual"].map(idx);
  if (!Array.isArray(doc?.rows) || iName < 0 || iAt < 0) return [];
  return (doc.rows as unknown[][]).flatMap((r): SourceRow[] => {
    const at = Date.parse(String(r[iAt] ?? ""));
    const name = text(r[iName]);
    if (!Number.isFinite(at) || !name) return [];
    return [{ source: "Yahoo Finance", code: name, title: name, country: iCountry >= 0 ? text(r[iCountry]) : undefined, at, forecast: iExpected >= 0 ? text(r[iExpected]) : undefined, previous: iPrior >= 0 ? text(r[iPrior]) : undefined, actual: iActual >= 0 ? text(r[iActual]) : undefined }];
  });
}

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Yahoo's cookie and crumb, kept for the life of the source and renewed when Yahoo refuses them. */
export function yahooCalendar(countries: readonly string[] = ["US"]): CalendarSource {
  let session: { cookie: string; crumb: string } | undefined;
  const start = async (io: FetchIO) => {
    const first = await io.fetch("https://fc.yahoo.com", { headers: { "User-Agent": BROWSER }, redirect: "manual" });
    const cookies: string[] = (first.headers as any).getSetCookie?.() ?? [];
    const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const res = await io.fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": BROWSER, Cookie: cookie } });
    const crumb = (await res.text()).trim();
    if (!res.ok || !crumb || /<|\s/.test(crumb)) throw new Error(`Yahoo gave no crumb (HTTP ${res.status})`);
    return (session = { cookie, crumb });
  };
  const page = async (io: FetchIO, s: { cookie: string; crumb: string }, from: number, to: number, offset: number) => {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const body = {
      sortType: "DESC",
      entityIdType: "economic_event",
      sortField: "startdatetime",
      includeFields: YAHOO_COLUMNS,
      size: 100,
      offset,
      query: {
        operator: "AND",
        operands: [
          { operator: "gte", operands: ["startdatetime", day(from)] },
          { operator: "lte", operands: ["startdatetime", day(to)] },
          countries.length === 1 ? { operator: "eq", operands: ["country_code", countries[0]] } : { operator: "OR", operands: countries.map((c) => ({ operator: "eq", operands: ["country_code", c] })) },
        ],
      },
    };
    return io.fetch(`https://query1.finance.yahoo.com/v1/finance/visualization?crumb=${encodeURIComponent(s.crumb)}&lang=en-US&region=US`, { method: "POST", headers: { "User-Agent": BROWSER, Cookie: s.cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  };
  return {
    id: "yahoo",
    name: "Yahoo Finance",
    async fetch(io, from, to) {
      const out: SourceRow[] = [];
      for (let offset = 0; offset < 500; offset += 100) {
        let s = session ?? (await start(io));
        let res = await page(io, s, from, to, offset);
        if (res.status === 401 || res.status === 403) {
          s = await start(io); // the crumb expired
          res = await page(io, s, from, to, offset);
        }
        if (!res.ok) throw new Error(`Yahoo calendar HTTP ${res.status}`);
        const rows = parseYahooCalendar(await res.json());
        out.push(...rows);
        if (rows.length < 100) break;
      }
      return out;
    },
  };
}

export const CALENDAR_SOURCES = (): CalendarSource[] => [financeCalendar, yahooCalendar()];

/** How far around now the secondary sources are asked for: their job is the release time and the actual, so the recent days and the next two weeks. */
export const SOURCE_WINDOW = { back: 3 * DAY, ahead: 14 * DAY };
