import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import {
  applyEiaActuals,
  decorateEvents,
  energyReleases,
  fredActual,
  fredSeriesFor,
  mcxHolidays,
  mergeForexFactory,
  parseFredCsv,
  parseWngsr,
  parseWpsr,
  releasePending,
  type CalEvent,
  type FFRow,
  type HolidayRow,
} from "@drishti/shared";
import { Db } from "./db";

const TTL_MS = 15 * 60_000;
const TTL_PENDING_MS = 60_000; // while a release is due or just out, look again every minute so its number appears when published
const UA = { "User-Agent": "Mozilla/5.0" };
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FF_TTL_MS = 30 * 60_000;
const FF_RETRY_MS = 5 * 60_000; // after a failed or throttled request, leave the feed alone this long (hammering it keeps the throttle on)
let ffNextTry = 0;
let ffCache: { at: number; rows: FFRow[] } | null = null;
let cache: { at: number; days: number; events: CalEvent[]; ttl: number } | null = null;

/**
 * Energy calendar: weekly US releases (API, EIA oil and gas, Baker Hughes) from a fixed schedule, enriched with
 * Forex Factory's free weekly feed (forecast/previous, USD high-impact macro, OPEC), plus MCX holidays from Upstox
 * when a token is set. Each source is optional: one being down just thins the list. Cached 15 min.
 * GET /calendar?days=14
 */
@Controller("calendar")
export class CalendarController {
  constructor(private readonly db: Db) {}

  @Get()
  async events(@Query("days") daysParam?: string): Promise<CalEvent[]> {
    const days = daysParam === undefined ? 14 : Number(daysParam);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new BadRequestException("days must be 1–60");
    if (cache && cache.days === days && Date.now() - cache.at < cache.ttl) return cache.events;

    const from = Date.now() - 6 * 3600_000; // keep today's earlier releases visible
    const to = Date.now() + days * 86_400_000;
    const [ff, holidays] = await Promise.all([this.forexFactory(), this.upstoxHolidays()]);
    const merged = [...mergeForexFactory(energyReleases(from, to), ff, from, to), ...mcxHolidays(holidays, from, to)].sort((a, b) => a.at - b.at);
    const events = await this.withActuals(decorateEvents(merged));
    // no Forex Factory rows (throttled) → look again in a minute instead of showing a forecast-less list for 15
    cache = { at: Date.now(), days, events, ttl: releasePending(events, Date.now()) || ff.length === 0 ? TTL_PENDING_MS : TTL_MS };
    return events;
  }

  /**
   * Released actuals, from the official sources: EIA's weekly files for the two EIA reports, FRED for the US macro releases.
   * Only fetched when some event has already happened; a file that still holds last week's numbers is ignored (see `fileIsForEvent`).
   */
  private async withActuals(events: CalEvent[]): Promise<CalEvent[]> {
    const now = Date.now();
    const due = events.filter((e) => e.at <= now && e.actual === undefined && e.kind !== "holiday");
    if (due.length === 0) return events;
    const text = async (url: string) => {
      try {
        const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
        return res.ok ? await res.text() : undefined;
      } catch {
        return undefined; // an unreachable source just means no actual yet
      }
    };
    const needOil = due.some((e) => e.id.startsWith("eia-oil-"));
    const needGas = due.some((e) => e.id.startsWith("eia-gas-"));
    const [oil, gas] = await Promise.all([needOil ? text("https://ir.eia.gov/wpsr/table1.csv") : undefined, needGas ? text("https://ir.eia.gov/ngs/wngsr.csv") : undefined]);
    let out = applyEiaActuals(events, { wpsr: oil ? parseWpsr(oil) : undefined, wngsr: gas ? parseWngsr(gas) : undefined }, now);

    // macro events: titles carry a " (US)" suffix from the merge
    const macro = due.filter((e) => e.kind === "macro" && fredSeriesFor(e.title.replace(/ \(US\)$/, "")));
    const ids = [...new Set(macro.map((e) => fredSeriesFor(e.title.replace(/ \(US\)$/, ""))!.seriesId))];
    const series = new Map(await Promise.all(ids.map(async (id) => [id, parseFredCsv((await text(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`)) ?? "")] as const)));
    out = out.map((e) => {
      if (e.kind !== "macro" || e.actual !== undefined || e.at > now) return e;
      const title = e.title.replace(/ \(US\)$/, "");
      const m = fredSeriesFor(title);
      const actual = m ? fredActual(title, "USD", e.at, now, series.get(m.seriesId) ?? []) : undefined;
      return actual === undefined ? e : { ...e, actual, src: { ...e.src, actual: "FRED (St. Louis Fed)" } };
    });
    return out;
  }

  /**
   * Forex Factory throttles hard (a few requests every few minutes per address), and the feed changes rarely, so keep the last
   * good copy for 30 minutes and, if a refresh fails, keep serving the old one rather than dropping every forecast.
   */
  private async forexFactory(): Promise<FFRow[]> {
    if (ffCache && Date.now() - ffCache.at < FF_TTL_MS) return ffCache.rows;
    if (!ffCache) {
      // after a restart: the copy saved in Redis (6 h) beats an empty list while the feed is throttling us
      const saved = await this.db.redis.get("calendar:ff").catch(() => null);
      const rows = saved ? (JSON.parse(saved) as FFRow[]) : null;
      if (Array.isArray(rows) && rows.length) ffCache = { at: Date.now() - FF_TTL_MS + 60_000, rows }; // stale: refresh soon, serve now
    }
    if (Date.now() < ffNextTry) return ffCache?.rows ?? [];
    try {
      const res = await fetch(FF_URL, { headers: UA, signal: AbortSignal.timeout(10_000) });
      const rows = res.ok ? ((await res.json()) as FFRow[]) : null;
      if (Array.isArray(rows) && rows.length) {
        ffCache = { at: Date.now(), rows };
        this.db.redis.set("calendar:ff", JSON.stringify(rows), "EX", 6 * 3600).catch(() => {});
        return rows;
      }
    } catch {
      /* fall through to the stale copy */
    }
    ffNextTry = Date.now() + FF_RETRY_MS;
    if (ffCache) ffCache = { ...ffCache, at: Date.now() - FF_TTL_MS + FF_RETRY_MS }; // serve the old copy, look again after the pause
    return ffCache?.rows ?? [];
  }

  private async upstoxHolidays(): Promise<HolidayRow[]> {
    const token = (await this.db.redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim();
    if (!token) return [];
    try {
      const res = await fetch("https://api.upstox.com/v2/market/holidays", {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      const json: any = await res.json();
      return res.ok && Array.isArray(json?.data) ? json.data : [];
    } catch {
      return [];
    }
  }
}
