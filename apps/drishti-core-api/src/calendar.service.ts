import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  applyEiaActuals,
  decorateEvents,
  energyReleases,
  fillEiaPrevious,
  fredActual,
  fredSeriesFor,
  applyEiaSchedule,
  CALENDAR_SOURCES,
  EIA_SCHEDULE_URLS,
  LruCache,
  mcxHolidays,
  mergeSourceRows,
  mergeForexFactory,
  parseEiaGasSchedule,
  parseEiaPetroleumSchedule,
  parseFredCsv,
  parseWngsr,
  parseWpsr,
  planEvents,
  recordPlanned,
  releasePending,
  seriesByCode,
  SOURCE_WINDOW,
  type CalendarSource,
  type EiaScheduleException,
  type PlannedEvent,
  type SourceRow,
  withUserAgent,
  type CalEvent,
  type FFRow,
  type HolidayRow,
} from "@drishti/shared";
import { Db } from "./db";
import { PgEventStore } from "./calendar.store";
import { PgEiaReportStore } from "./eia-report.store";

const TTL_MS = 15 * 60_000;
const TTL_PENDING_MS = 60_000; // while a release is due or just out, look again every minute so its number appears when published
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FF_TTL_MS = 30 * 60_000;
const FF_RETRY_MS = 5 * 60_000; // after a failed or throttled request, leave the feed alone this long (hammering it keeps the throttle on)
let ffNextTry = 0;
let ffCache: { at: number; rows: FFRow[] } | null = null;
const cache = new LruCache<{ at: number; events: CalEvent[]; ttl: number }>(8); // by number of days: the panel (14) and the recorder (56) ask for different spans
const RECORD_AHEAD_DAYS = 56;
const RECORD_EVERY_MS = 5 * 60_000;
const SOURCE_EVERY_MS = 15 * 60_000; // the extra sources are asked this often, and every minute while a release is pending
const SOURCE_RETRY_MS = 5 * 60_000; // after a failure, leave a source alone this long
const SCHEDULE_TTL_MS = 24 * 3600_000; // EIA changes its holiday list a few times a year
const SCHEDULE_RETRY_MS = 10 * 60_000;
const RECORD_PENDING_MS = 60_000; // while a release is due or just out, look every minute so the actual is stored when published

/**
 * The live calendar: weekly US releases (API, EIA oil and gas, Baker Hughes) from a fixed schedule, enriched with
 * Forex Factory's free weekly feed (forecast/previous, USD high-impact macro, OPEC), plus MCX holidays from Upstox
 * when a token is set. Each source is optional: one being down just thins the list. Cached 15 min.
 */
@Injectable()
export class CalendarService implements OnModuleInit, OnModuleDestroy {
  readonly store: PgEventStore;
  private readonly reports: PgEiaReportStore;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failing = false;
  private schedule: { list: EiaScheduleException[]; at: number; retryAt: number } = { list: [], at: 0, retryAt: 0 };
  private readonly sources: { source: CalendarSource; rows: SourceRow[]; at: number; retryAt: number; failing: boolean }[] = CALENDAR_SOURCES().map((source) => ({ source, rows: [], at: 0, retryAt: 0, failing: false }));

  constructor(private readonly db: Db) {
    this.store = new PgEventStore(db.sql);
    this.reports = new PgEiaReportStore(db.sql);
  }

  onModuleInit() {
    if (process.env.CALENDAR_RECORDER?.trim().toLowerCase() === "off") return;
    this.timer = setTimeout(() => void this.tick(), 10_000);
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }

  private async tick() {
    let next = RECORD_EVERY_MS;
    try {
      const r = await this.record();
      this.failing = false;
      if (r.pending) next = RECORD_PENDING_MS;
      if (r.created + r.moved + r.observations + r.released > 0) console.log(`calendar recorder: ${r.created} new, ${r.moved} moved, ${r.observations} figures, ${r.released} released`);
    } catch (e) {
      if (!this.failing) console.warn(`calendar recorder: ${(e as Error).message}`); // once per outage
      this.failing = true;
    }
    this.timer = setTimeout(() => void this.tick(), next);
  }

  /**
   * One recorder pass: the live calendar for the next 8 weeks becomes stored events and appended figures (forecast, previous and actual, each with its
   * source). The full EIA tables are the EIA report watcher's job (eia-report.service.ts). Running it twice changes nothing.
   */
  async record(now = Date.now()) {
    const events = await this.events(RECORD_AHEAD_DAYS);
    const from = now - 6 * 3600_000;
    const pending = releasePending(events, now);
    const r = await recordPlanned(this.store, planEvents(events), from, now + RECORD_AHEAD_DAYS * 86_400_000, now);
    const extra = await this.mergeSources(now, pending);
    return { ...r, observations: r.observations + extra, pending };
  }

  /**
   * Adds what the other free sources say about the same releases (their figures and release times, under their own names) to the STORED events, so a
   * release from a few days ago still gets its actual from a second source. Each source is asked on its own schedule, one failing never stops the
   * others or the recording, and the last good rows are used again until it answers. Returns the number of new figures stored.
   */
  private async mergeSources(now: number, pending: boolean): Promise<number> {
    const io = { fetch: (input: string | URL, init?: RequestInit) => fetch(input, withUserAgent(input, init)), env: process.env, now: Date.now };
    await Promise.all(
      this.sources.map(async (s) => {
        if (now < s.retryAt || now - s.at < (pending ? RECORD_PENDING_MS : SOURCE_EVERY_MS)) return;
        try {
          s.rows = await s.source.fetch(io, now - SOURCE_WINDOW.back, now + SOURCE_WINDOW.ahead);
          s.at = now;
          s.failing = false;
        } catch (e) {
          s.retryAt = now + SOURCE_RETRY_MS;
          if (!s.failing) console.warn(`calendar source ${s.source.name}: ${(e as Error).message}`); // once per outage
          s.failing = true;
        }
      }),
    );
    const refs = await this.store.stored(now - SOURCE_WINDOW.back - 86_400_000, now + SOURCE_WINDOW.ahead + 86_400_000);
    const targets = refs.flatMap((ref) => {
      const series = seriesByCode(ref.seriesCode);
      return series ? [{ id: ref.id, planned: { series, key: ref.key, at: ref.scheduledAt, title: series.title, observations: [] } as PlannedEvent }] : [];
    });
    for (const s of this.sources) mergeSourceRows(targets.map((x) => x.planned), s.source.id, s.rows);
    let fresh = 0;
    for (const x of targets) if (x.planned.observations.length) fresh += await this.store.addObservations(x.id, x.planned.observations);
    return fresh;
  }

  /**
   * EIA's official holiday exceptions for the two weekly reports, read from its two schedule pages and kept a day. A failing page keeps the last good
   * list and is tried again in ten minutes; with none, the standard days and Forex Factory's shifts still apply.
   */
  async eiaSchedule(now = Date.now()): Promise<EiaScheduleException[]> {
    const s = this.schedule;
    if (now - s.at < SCHEDULE_TTL_MS || now < s.retryAt) return s.list;
    const [petroleum, gas] = await Promise.all([this.text(EIA_SCHEDULE_URLS.WPSR), this.text(EIA_SCHEDULE_URLS.WNGSR)]);
    const list = [...(petroleum ? parseEiaPetroleumSchedule(petroleum) : []), ...(gas ? parseEiaGasSchedule(gas) : [])];
    if (petroleum && gas && list.length) this.schedule = { list, at: now, retryAt: 0 };
    else {
      this.schedule = { ...s, retryAt: now + SCHEDULE_RETRY_MS };
      if (!s.list.length) console.warn("EIA schedule pages could not be read: using the standard days and Forex Factory's shifts");
    }
    return this.schedule.list;
  }

  private async text(url: string) {
    try {
      const res = await fetch(url, { ...withUserAgent(url), signal: AbortSignal.timeout(10_000) });
      return res.ok ? await res.text() : undefined;
    } catch {
      return undefined; // an unreachable source just means nothing yet
    }
  }

  async events(days: number): Promise<CalEvent[]> {
    const hit = cache.get(String(days));
    if (hit && Date.now() - hit.at < hit.ttl) return hit.events;

    const from = Date.now() - 6 * 3600_000; // keep today's earlier releases visible
    const to = Date.now() + days * 86_400_000;
    const [ff, holidays] = await Promise.all([this.forexFactory(), this.upstoxHolidays()]);
    const merged = [...mergeForexFactory(energyReleases(from, to), ff, from, to), ...mcxHolidays(holidays, from, to)].sort((a, b) => a.at - b.at);
    const official = applyEiaSchedule(merged, await this.eiaSchedule()); // EIA's own days and times win over any feed
    const withPrevious = await fillEiaPrevious(decorateEvents(official), (report, week) => this.reports.headlineChangeOf(report, week).catch(() => undefined)); // no database: no previous, not an error
    const events = await this.withActuals(withPrevious);
    // no Forex Factory rows (throttled) → look again in a minute instead of showing a forecast-less list for 15
    cache.set(String(days), { at: Date.now(), events, ttl: releasePending(events, Date.now()) || ff.length === 0 ? TTL_PENDING_MS : TTL_MS });
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
    const text = (url: string) => this.text(url);
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
      const res = await fetch(FF_URL, { ...withUserAgent(FF_URL), signal: AbortSignal.timeout(10_000) });
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
