import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { buildForecastTable, INVESTING_BLOCK_MS, INVESTING_PAGES, investingProblem, parseInvestingEvent, shouldFetchInvesting, withUserAgent, type ForecastRowIn, type ForecastTable, type InvestingOccurrence, type InvestingPage, type InvestingSeries, type PublishedChange } from "@drishti/shared";
import { Db } from "./db";

const SOURCE = "investing.com";
const CHECK_EVERY_MS = 10 * 60_000;
const GAP_MS = 4000; // between two pages: a handful of requests a day, never a burst
/** a forecast belongs to a release when its scheduled time is this close to the report's official time (a holiday moves it by hours, not days) */
const MATCH_MS = 20 * 3600_000;
/** the API reports the day before the EIA does: its release falls this far before the EIA release */
const API_BEFORE_MS = { from: 48 * 3600_000, to: 6 * 3600_000 };

export interface ForecastRow {
  series: InvestingSeries;
  releaseAt: number;
  forecast?: number;
  previous?: number;
  actual?: number;
}

export interface ForecastStatus {
  on: boolean;
  blockedUntil: number | null;
  lastError?: string;
  pages: { series: InvestingSeries; rows: number; withForecast: number; lastFetchAt: number | null; nextRelease: number | null }[];
}

/** What a page fetch needs from outside, so the rules are tested with fakes. */
export interface ForecastIO {
  get(url: string): Promise<{ status: number; text: string }>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

const liveIO: ForecastIO = {
  get: async (url) => {
    const res = await fetch(url, withUserAgent(url, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(30_000) }));
    return { status: res.status, text: await res.text() };
  },
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (l) => console.log(l),
};

/**
 * Keeps the consensus forecasts of the four weekly releases (EIA crude, gasoline, distillates and the API's crude) in `release_forecasts`, read from
 * Investing.com's event pages. Polite by construction: a page is read at most every six hours (every thirty minutes in the ninety before a release),
 * pages are four seconds apart, and the first answer that is not a page (a block, a bot check, a layout change) stops everything for twelve hours.
 * INVESTING_FORECASTS=off disables it. Third-party and unofficial: its figures rank below a forecast typed in or recorded from Forex Factory.
 */
@Injectable()
export class ForecastService implements OnModuleInit, OnModuleDestroy {
  io: ForecastIO = liveIO;
  private timer?: ReturnType<typeof setInterval>;
  private blockedUntil = 0;
  private lastError?: string;
  private running = false;
  private readonly lastFetch = new Map<InvestingSeries, number>();

  constructor(private readonly db: Db) {}

  onModuleInit() {
    if (!this.enabled()) return;
    setTimeout(() => void this.tick(), 45_000);
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  enabled() {
    return process.env.INVESTING_FORECASTS?.trim().toLowerCase() !== "off";
  }

  /** One pass: read the pages that are due, store what they hold. Returns the pages read. */
  async tick(): Promise<InvestingSeries[]> {
    if (this.running) return [];
    this.running = true;
    const read: InvestingSeries[] = [];
    try {
      for (const page of INVESTING_PAGES) {
        const now = this.io.now();
        const last = this.lastFetch.get(page.series) ?? (await this.lastFetchOf(page.series));
        if (!shouldFetchInvesting(now, last, await this.nextReleaseOf(page.series, now), this.blockedUntil)) continue;
        if (read.length) await this.io.sleep(GAP_MS);
        if (!(await this.readPage(page))) break; // the site said no: nothing more this pass
        read.push(page.series);
      }
    } finally {
      this.running = false;
    }
    return read;
  }

  /** Read and store one page; false when the site did not give a page (and everything is then left alone for a while). */
  private async readPage(page: InvestingPage): Promise<boolean> {
    const res = await this.io.get(page.url).catch((e: Error) => ({ status: 0, text: e.message }));
    const problem = res.status === 0 ? `Investing.com could not be reached: ${res.text}` : investingProblem(res.status, res.text);
    const rows = problem ? undefined : parseInvestingEvent(res.text);
    if (problem || !rows) {
      this.blockedUntil = this.io.now() + INVESTING_BLOCK_MS;
      this.lastError = problem ?? "the page no longer has the event data: its layout changed";
      this.io.log(`Investing.com forecasts paused for ${INVESTING_BLOCK_MS / 3600_000} h: ${this.lastError}`);
      return false;
    }
    this.lastFetch.set(page.series, this.io.now());
    this.lastError = undefined;
    const stored = await this.store(page.series, rows.map((o) => this.rowOf(page.series, o)));
    this.io.log(`Investing.com ${page.series}: ${rows.length} occurrences read, ${stored} stored`);
    return true;
  }

  private rowOf = (series: InvestingSeries, o: InvestingOccurrence): ForecastRow & { occurrenceId: number; unit: string } => ({ series, releaseAt: o.at, forecast: o.forecast, previous: o.previous, actual: o.actual, occurrenceId: o.occurrenceId, unit: o.unit });

  /** Upsert occurrences: a figure already on record is kept when the page no longer shows one. */
  async store(series: InvestingSeries, rows: (ForecastRow & { occurrenceId?: number; unit?: string })[]): Promise<number> {
    if (!rows.length) return 0;
    const payload = rows.map((r) => ({ series, release_at: new Date(r.releaseAt).toISOString(), occurrence_id: r.occurrenceId ?? null, forecast: r.forecast ?? null, previous: r.previous ?? null, actual: r.actual ?? null, unit: r.unit ?? null }));
    for (let i = 0; i < payload.length; i += 200) {
      await this.db.sql`
        INSERT INTO release_forecasts (series, release_at, source, occurrence_id, forecast, previous, actual, unit)
        SELECT x.series, x.release_at::timestamptz, ${SOURCE}, x.occurrence_id, x.forecast, x.previous, x.actual, x.unit
        FROM jsonb_to_recordset(${JSON.stringify(payload.slice(i, i + 200))}::text::jsonb) AS x(series text, release_at text, occurrence_id bigint, forecast double precision, previous double precision, actual double precision, unit text)
        ON CONFLICT (series, release_at) DO UPDATE SET
          occurrence_id = EXCLUDED.occurrence_id, unit = EXCLUDED.unit, fetched_at = now(),
          forecast = COALESCE(EXCLUDED.forecast, release_forecasts.forecast), previous = COALESCE(EXCLUDED.previous, release_forecasts.previous), actual = COALESCE(EXCLUDED.actual, release_forecasts.actual)`;
    }
    return payload.length;
  }

  private async lastFetchOf(series: InvestingSeries): Promise<number | undefined> {
    const r = (await this.db.sql`SELECT max(fetched_at) AS t FROM release_forecasts WHERE series = ${series}`.catch(() => [])) as { t: Date | null }[];
    return r[0]?.t ? new Date(r[0].t).getTime() : undefined;
  }

  private async nextReleaseOf(series: InvestingSeries, now: number): Promise<number | undefined> {
    const r = (await this.db.sql`SELECT min(release_at) AS t FROM release_forecasts WHERE series = ${series} AND release_at > ${new Date(now - 10 * 60_000).toISOString()}`.catch(() => [])) as { t: Date | null }[];
    return r[0]?.t ? new Date(r[0].t).getTime() : undefined;
  }

  /** The forecast row of a series for the release at (or near) `at`; the closest within a day. */
  async around(series: InvestingSeries, at: number): Promise<ForecastRow | undefined> {
    const r = (await this.db.sql`
      SELECT series, extract(epoch FROM release_at)::float8 * 1000 AS release_at, forecast, previous, actual FROM release_forecasts
      WHERE series = ${series} AND release_at BETWEEN ${new Date(at - MATCH_MS).toISOString()} AND ${new Date(at + MATCH_MS).toISOString()}
      ORDER BY abs(extract(epoch FROM release_at) - ${at / 1000}) LIMIT 1`.catch(() => [])) as { series: InvestingSeries; release_at: number; forecast: number | null; previous: number | null; actual: number | null }[];
    const x = r[0];
    return x && { series: x.series, releaseAt: Math.round(Number(x.release_at)), forecast: x.forecast ?? undefined, previous: x.previous ?? undefined, actual: x.actual ?? undefined };
  }

  /** The EIA crude forecast for a petroleum release, as the report's forecast of last resort (below a typed-in figure and Forex Factory's). */
  async crudeFor(releaseAt: number): Promise<{ value: number; source: string } | undefined> {
    const row = await this.around("eia_crude", releaseAt);
    return row?.forecast === undefined ? undefined : { value: row.forecast, source: "Investing.com consensus" };
  }

  /** Gasoline and distillate forecasts for the release, and the API's report the day before it. */
  async expectationsFor(releaseAt: number): Promise<{ gasoline?: number; distillates?: number; api?: { change: number; forecast?: number; at: number } }> {
    const [gasoline, distillates] = await Promise.all([this.around("eia_gasoline", releaseAt), this.around("eia_distillates", releaseAt)]);
    const apiRows = (await this.db.sql`
      SELECT extract(epoch FROM release_at)::float8 * 1000 AS release_at, forecast, actual FROM release_forecasts
      WHERE series = 'api_crude' AND release_at BETWEEN ${new Date(releaseAt - API_BEFORE_MS.from).toISOString()} AND ${new Date(releaseAt - API_BEFORE_MS.to).toISOString()}
      ORDER BY release_at DESC LIMIT 1`.catch(() => [])) as { release_at: number; forecast: number | null; actual: number | null }[];
    const api = apiRows[0]?.actual != null ? { change: Number(apiRows[0].actual), forecast: apiRows[0].forecast ?? undefined, at: Math.round(Number(apiRows[0].release_at)) } : undefined;
    return { gasoline: gasoline?.forecast, distillates: distillates?.forecast, api };
  }

  /**
   * The forecasts laid against what came out, for the newest `weeks` EIA releases and the next one: the forecasts are Investing.com's, the actuals are
   * the figures from the reports we stored as published (the page's own figure fills a week with no stored report).
   */
  async table(weeks: number, threshold = 3): Promise<ForecastTable & { threshold: number }> {
    const from = new Date(this.io.now() - (weeks + 2) * 7 * 86_400_000).toISOString();
    const rows = (await this.db.sql`
      SELECT series, extract(epoch FROM release_at)::float8 * 1000 AS release_at, forecast, actual FROM release_forecasts WHERE release_at >= ${from} ORDER BY release_at`.catch(() => [])) as { series: ForecastRow["series"]; release_at: number; forecast: number | null; actual: number | null }[];
    const changes = (await this.db.sql`
      SELECT extract(epoch FROM a.official_release_at)::float8 * 1000 AS at, v.series_id, v.change
      FROM eia_report_arrivals a JOIN eia_report_values v ON v.event_id = a.event_id
      WHERE a.official_release_at >= ${from} AND v.series_id IN ('WPSR:T1:COMMERCIAL_EXCLUDING_SPR', 'WPSR:T1:TOTAL_MOTOR_GASOLINE', 'WPSR:T1:DISTILLATE_FUEL_OIL')`.catch(() => [])) as { at: number; series_id: string; change: number | null }[];
    const key: Record<string, "crude" | "gasoline" | "distillates"> = { "WPSR:T1:COMMERCIAL_EXCLUDING_SPR": "crude", "WPSR:T1:TOTAL_MOTOR_GASOLINE": "gasoline", "WPSR:T1:DISTILLATE_FUEL_OIL": "distillates" };
    const published = new Map<number, PublishedChange>();
    for (const c of changes) {
      const at = Math.round(Number(c.at));
      const p = published.get(at) ?? { at };
      if (c.change !== null) p[key[c.series_id]] = Number(c.change);
      published.set(at, p);
    }
    const input: ForecastRowIn[] = rows.map((r) => ({ series: r.series, releaseAt: Math.round(Number(r.release_at)), forecast: r.forecast ?? undefined, actual: r.actual ?? undefined }));
    return { ...buildForecastTable({ rows: input, published: [...published.values()], now: this.io.now(), weeks, threshold }), threshold };
  }

  async status(): Promise<ForecastStatus> {
    const rows = (await this.db.sql`
      SELECT series, count(*)::int AS n, count(forecast)::int AS f, max(fetched_at) AS last, min(release_at) FILTER (WHERE release_at > now()) AS next FROM release_forecasts GROUP BY series`.catch(() => [])) as { series: InvestingSeries; n: number; f: number; last: Date | null; next: Date | null }[];
    return {
      on: this.enabled(),
      blockedUntil: this.blockedUntil > this.io.now() ? this.blockedUntil : null,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      pages: INVESTING_PAGES.map((p) => {
        const r = rows.find((x) => x.series === p.series);
        return { series: p.series, rows: r?.n ?? 0, withForecast: r?.f ?? 0, lastFetchAt: r?.last ? new Date(r.last).getTime() : null, nextRelease: r?.next ? new Date(r.next).getTime() : null };
      }),
    };
  }
}
