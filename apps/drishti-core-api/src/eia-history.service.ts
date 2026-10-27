import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { eiaIdOf, HISTORY_SERIES, limiter, parseEia, seriesContext, type EiaPoint, type EiaReportRow, type HistorySeries, type SeriesContext } from "@drishti/shared";
import { Db } from "./db";

const FULL_LENGTH = 640; // about twelve years of weeks: five for the same-week range, the rest for streaks and "lowest since"
const TOP_UP_LENGTH = 12;
const SYNC_EVERY_MS = 6 * 3600_000;
const STALE_AFTER_DAYS = 8; // the report comes weekly: a newest point older than this is worth a top-up
const gate = limiter(2); // EIA is slow and rate limited (1 to 45 s a call): never more than two at once

/** One week where the figure EIA published in the report and the figure its API serves now differ: a revision. */
export interface Revision {
  week: string;
  series: string;
  published: number;
  api: number;
  diff: number;
}

export interface CrossCheck {
  report: "WPSR" | "WNGSR";
  /** published weeks looked at, and series-weeks compared */
  weeks: number;
  compared: number;
  matching: number;
  revisions: Revision[];
  bySeries: { key: string; compared: number; revised: number; maxAbsDiff: number }[];
}

export interface HistoryStatus {
  /** weeks of each report stored AS PUBLISHED (from the report files: the release-day watcher and the archive backfill) */
  published: { WPSR: number; WNGSR: number };
  series: { key: string; eia: string; points: number; first: string | null; last: string | null }[];
  syncing: boolean;
  lastSyncAt: number | null;
  lastError?: string;
}

/**
 * Keeps the weekly history behind the release articles in Postgres: the first run loads about twelve years of each series from EIA's Open Data API
 * v2, later runs add the newest weeks (every six hours, and only for a series whose newest point is over a week old). Needs EIA_API_KEY; without it,
 * or with EIA_HISTORY=off, nothing runs. A route EIA does not serve is skipped and noted, never guessed.
 */
@Injectable()
export class EiaHistoryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private lastSyncAt: number | null = null;
  private lastError?: string;
  private lastTopUp = 0;

  constructor(private readonly db: Db) {}

  onModuleInit() {
    if (process.env.EIA_HISTORY?.trim().toLowerCase() === "off" || !process.env.EIA_API_KEY?.trim()) return;
    setTimeout(() => void this.sync(), 30_000);
    this.timer = setInterval(() => void this.sync(), SYNC_EVERY_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Load what is missing or stale, one series at a time (two in flight). Safe to call again while it runs. */
  async sync(now = Date.now()): Promise<{ loaded: number; skipped: string[] }> {
    const key = process.env.EIA_API_KEY?.trim();
    if (!key || this.running) return { loaded: 0, skipped: [] };
    this.running = true;
    const skipped: string[] = [];
    let loaded = 0;
    try {
      const have = (await this.db.sql`SELECT series, count(*)::int AS n, max(period)::text AS last FROM eia_history GROUP BY series`) as { series: string; n: number; last: string }[];
      const byId = new Map(have.map((h) => [h.series, h]));
      await Promise.all(
        HISTORY_SERIES.map((s) =>
          gate(async () => {
            const id = eiaIdOf(s.route);
            const h = byId.get(id);
            const fresh = h && now - Date.parse(`${h.last}T00:00:00Z`) < STALE_AFTER_DAYS * 86_400_000;
            if (fresh && h.n >= 300) return;
            try {
              loaded += await this.load(s, key, h && h.n >= 300 ? TOP_UP_LENGTH : FULL_LENGTH);
            } catch (e) {
              skipped.push(`${s.key}: ${(e as Error).message}`);
            }
          }),
        ),
      );
      this.lastError = skipped.length ? skipped.join("; ") : undefined;
      this.lastSyncAt = Date.now();
      if (loaded || skipped.length) console.log(`EIA history: ${loaded} points loaded${skipped.length ? `, skipped ${skipped.length} (${skipped.join("; ").slice(0, 300)})` : ""}`);
    } finally {
      this.running = false;
    }
    return { loaded, skipped };
  }

  private async load(s: HistorySeries, key: string, length: number): Promise<number> {
    const url = new URL(`https://api.eia.gov/v2/seriesid/${s.route}`);
    url.searchParams.set("api_key", key);
    url.searchParams.set("length", String(length));
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`EIA answered ${res.status}`);
    const points = parseEia(await res.json().catch(() => null));
    if (!points.length) throw new Error("no data");
    const id = eiaIdOf(s.route);
    const rows = points.map((p) => ({ series: id, period: p.period, value: p.value }));
    for (let i = 0; i < rows.length; i += 500) await this.db.sql`INSERT INTO eia_history ${this.db.sql(rows.slice(i, i + 500))} ON CONFLICT (series, period) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`;
    return rows.length;
  }

  /**
   * One series in the report's own unit (stocks in million barrels), oldest first. The figure EIA PUBLISHED in each stored report is the source of
   * truth and wins for its week; EIA's API (which serves later, revised values) fills the weeks that have no stored report, and is otherwise only a
   * cross-check (see `crosscheck`).
   */
  async points(s: HistorySeries): Promise<EiaPoint[]> {
    const api = (await this.db.sql`SELECT period::text AS period, value FROM eia_history WHERE series = ${eiaIdOf(s.route)} ORDER BY period`) as { period: string; value: number }[];
    const published = await this.published(s);
    const byWeek = new Map<string, number>(api.map((r) => [r.period, Number((r.value / s.div).toFixed(6))]));
    for (const p of published) byWeek.set(p.period, p.value);
    return [...byWeek].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
  }

  /** The values of one series as the stored reports published them, by week. */
  async published(s: HistorySeries): Promise<EiaPoint[]> {
    const rows = (await this.db.sql`SELECT DISTINCT ON (v.period_end) v.period_end::text AS period, v.value FROM eia_report_values v WHERE v.series_id = ${s.seriesId} ORDER BY v.period_end, v.event_id`.catch(() => [])) as { period: string; value: number }[];
    return rows.map((r) => ({ period: r.period, value: Number(r.value) }));
  }

  /**
   * Published against EIA's API for the newest `weeks` stored weeks: where they differ, the report was later revised (the API serves the revised
   * figure). The published value is the one that stands; this shows how much, and where, it moved.
   */
  async crosscheck(report: "WPSR" | "WNGSR", weeks = 26): Promise<CrossCheck> {
    const out: CrossCheck = { report, weeks: 0, compared: 0, matching: 0, revisions: [], bySeries: [] };
    const seen = new Set<string>();
    for (const s of HISTORY_SERIES.filter((x) => x.report === report)) {
      const pub = (await this.published(s)).slice(-weeks);
      const api = (await this.db.sql`SELECT period::text AS period, value FROM eia_history WHERE series = ${eiaIdOf(s.route)}`) as { period: string; value: number }[];
      const apiBy = new Map(api.map((r) => [r.period, r.value / s.div]));
      const tol = s.unit === "%" ? 0.05 : s.div === 1000 ? 0.0015 : 0.5; // rounding in the two sources: 1.5 thousand barrels, 0.05 points, half a unit
      let compared = 0;
      let revised = 0;
      let max = 0;
      for (const p of pub) {
        const a = apiBy.get(p.period);
        if (a === undefined) continue;
        seen.add(p.period);
        compared++;
        const diff = Number((a - p.value).toFixed(4));
        if (Math.abs(diff) > tol) {
          revised++;
          max = Math.max(max, Math.abs(diff));
          out.revisions.push({ week: p.period, series: s.key, published: p.value, api: Number(a.toFixed(4)), diff });
        }
      }
      out.compared += compared;
      out.bySeries.push({ key: s.key, compared, revised, maxAbsDiff: Number(max.toFixed(4)) });
    }
    out.weeks = seen.size;
    out.matching = out.compared - out.revisions.length;
    out.revisions.sort((a, b) => b.week.localeCompare(a.week) || a.series.localeCompare(b.series));
    return out;
  }

  /**
   * The context of every series a report cites, as of the report's week. A series with no history is left out.
   * EIA's API publishes a new week some time after the report files do, so at the moment of a release the history can end a week early: when the
   * report's own rows are given, its figure for that week stands in for the missing point (it is the authoritative number, and the API's value
   * replaces it when it arrives), and a stale history starts a top-up in the background, at most one every five minutes.
   */
  async contexts(report: "WPSR" | "WNGSR", weekEnding: string, rows?: readonly EiaReportRow[]): Promise<Record<string, SeriesContext>> {
    const out: Record<string, SeriesContext> = {};
    let stale = false;
    for (const s of HISTORY_SERIES.filter((x) => x.report === report)) {
      const points = await this.points(s);
      if (!points.length || points[points.length - 1].period < weekEnding) {
        stale = true;
        const own = rows?.find((r) => r.seriesId === s.seriesId);
        if (own && points.length) points.push({ period: weekEnding, value: own.value });
      }
      const c = seriesContext(points, weekEnding);
      if (c) out[s.key] = c;
    }
    if (stale && Date.now() - this.lastTopUp > 5 * 60_000) {
      this.lastTopUp = Date.now();
      void this.sync().catch(() => undefined);
    }
    return out;
  }

  async status(): Promise<HistoryStatus> {
    const rows = (await this.db.sql`SELECT series, count(*)::int AS n, min(period)::text AS first, max(period)::text AS last FROM eia_history GROUP BY series`) as { series: string; n: number; first: string; last: string }[];
    const byId = new Map(rows.map((r) => [r.series, r]));
    const pub = (await this.db.sql`
      SELECT s.report, count(DISTINCT v.period_end)::int AS n FROM eia_report_values v JOIN eia_series s ON s.id = v.series_id GROUP BY s.report`.catch(() => [])) as { report: string; n: number }[];
    return {
      published: { WPSR: pub.find((r) => r.report === "WPSR")?.n ?? 0, WNGSR: pub.find((r) => r.report === "WNGSR")?.n ?? 0 },
      series: HISTORY_SERIES.map((s) => {
        const r = byId.get(eiaIdOf(s.route));
        return { key: s.key, eia: eiaIdOf(s.route), points: r?.n ?? 0, first: r?.first ?? null, last: r?.last ?? null };
      }),
      syncing: this.running,
      lastSyncAt: this.lastSyncAt,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}
