import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { eiaIdOf, HISTORY_SERIES, limiter, parseEia, seriesContext, type EiaPoint, type HistorySeries, type SeriesContext } from "@drishti/shared";
import { Db } from "./db";

const FULL_LENGTH = 640; // about twelve years of weeks: five for the same-week range, the rest for streaks and "lowest since"
const TOP_UP_LENGTH = 12;
const SYNC_EVERY_MS = 6 * 3600_000;
const STALE_AFTER_DAYS = 8; // the report comes weekly: a newest point older than this is worth a top-up
const gate = limiter(2); // EIA is slow and rate limited (1 to 45 s a call): never more than two at once

export interface HistoryStatus {
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

  /** One series in the report's own unit (stocks in million barrels), oldest first. */
  async points(s: HistorySeries): Promise<EiaPoint[]> {
    const rows = (await this.db.sql`SELECT period::text AS period, value FROM eia_history WHERE series = ${eiaIdOf(s.route)} ORDER BY period`) as { period: string; value: number }[];
    return rows.map((r) => ({ period: r.period, value: Number((r.value / s.div).toFixed(6)) }));
  }

  /** The context of every series a report cites, as of the report's week. A series with no history is left out. */
  async contexts(report: "WPSR" | "WNGSR", weekEnding: string): Promise<Record<string, SeriesContext>> {
    const out: Record<string, SeriesContext> = {};
    for (const s of HISTORY_SERIES.filter((x) => x.report === report)) {
      const c = seriesContext(await this.points(s), weekEnding);
      if (c) out[s.key] = c;
    }
    return out;
  }

  async status(): Promise<HistoryStatus> {
    const rows = (await this.db.sql`SELECT series, count(*)::int AS n, min(period)::text AS first, max(period)::text AS last FROM eia_history GROUP BY series`) as { series: string; n: number; first: string; last: string }[];
    const byId = new Map(rows.map((r) => [r.series, r]));
    return {
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
