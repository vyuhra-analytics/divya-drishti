import type { SQL } from "bun";
import { seriesByCode, weekKey, type EiaReport, type EiaReportCode, type EiaReportRow, type PlannedEvent } from "@drishti/shared";
import { PgEventStore } from "./calendar.store";

const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);

export interface StoredReport {
  eventId: number;
  report: EiaReportCode;
  weekEnding: string;
  scheduledAt: number;
  officialReleaseAt?: number;
  firstStoredAt?: number;
  delayMs?: number;
  /** stored long after the release: the delay says nothing about the watcher */
  backfilled?: boolean;
  rows: EiaReportRow[];
}

/** The full EIA reports over Postgres (tables from migrations 014 and 015). */
export class PgEiaReportStore {
  private readonly events: PgEventStore;

  constructor(private readonly sql: SQL) {
    this.events = new PgEventStore(sql);
  }

  /** The earliest release of a report, from three days ago on, that has no rows stored yet. */
  async nextUnstored(report: EiaReportCode, now: number): Promise<{ id: number; key: string; at: number } | undefined> {
    const rows = (await this.sql`
      SELECT e.id, e.key, e.scheduled_at FROM economic_events e
      WHERE e.series_code = ${report} AND e.scheduled_at > ${iso(now - 3 * 86_400_000)}
        AND NOT EXISTS (SELECT 1 FROM eia_report_values v WHERE v.event_id = e.id AND v.seq IS NOT NULL)
      ORDER BY e.scheduled_at LIMIT 1`) as { id: string | number; key: string; scheduled_at: Date }[];
    return rows[0] && { id: Number(rows[0].id), key: rows[0].key, at: new Date(rows[0].scheduled_at).getTime() };
  }

  /** The stored event of a week (made, with its series, when the recorder has not seen it: a report the app missed while it was off). */
  async eventFor(report: EiaReportCode, periodEnd: number, releaseAt: number): Promise<{ id: number; scheduledAt: number; hasRows: boolean }> {
    const def = seriesByCode(report)!;
    const key = weekKey(periodEnd);
    const find = async () =>
      (await this.sql`
        SELECT e.id, e.scheduled_at, EXISTS (SELECT 1 FROM eia_report_values v WHERE v.event_id = e.id AND v.seq IS NOT NULL) AS has_rows
        FROM economic_events e WHERE e.series_code = ${report} AND e.key = ${key}`) as { id: string | number; scheduled_at: Date; has_rows: boolean }[];
    let r = await find();
    if (r.length === 0) {
      await this.events.upsertSeries(def);
      const planned: PlannedEvent = { series: def, key, at: releaseAt, title: def.title, period: key, observations: [] };
      await this.events.insertEvent(planned);
      r = await find();
    }
    return { id: Number(r[0].id), scheduledAt: new Date(r[0].scheduled_at).getTime(), hasRows: r[0].has_rows };
  }

  /** Every row of the report against its event, and the release marked as out. One statement per table; a repeat updates in place. */
  async saveReport(eventId: number, report: EiaReport, officialAt: number, storedAt: number): Promise<number> {
    const series = report.rows.map((r) => ({ id: r.seriesId, report: r.report, table_id: r.table, grp: r.group, parent: r.parent, label: r.label, unit: r.unit, headline: r.headline }));
    const values = report.rows.map((r) => ({
      series_id: r.seriesId,
      seq: r.seq,
      period_end: day(r.periodEnd),
      value: r.value,
      prior: r.prior ?? null,
      change: r.change ?? null,
      year_ago: r.yearAgo ?? null,
      year_ago_pct: r.yearAgoPct ?? null,
      avg4: r.avg4 ?? null,
      avg4_year_ago: r.avg4YearAgo ?? null,
      five_year: r.fiveYear ?? null,
      five_year_pct: r.fiveYearPct ?? null,
    }));
    await this.sql`
      INSERT INTO eia_series (id, report, table_id, grp, parent, label, unit, headline)
      SELECT x.id, x.report, x.table_id, x.grp, x.parent, x.label, x.unit, x.headline
      FROM jsonb_to_recordset(${JSON.stringify(series)}::text::jsonb) AS x(id text, report text, table_id text, grp text, parent text, label text, unit text, headline boolean)
      ON CONFLICT (id) DO UPDATE SET table_id = EXCLUDED.table_id, grp = EXCLUDED.grp, parent = EXCLUDED.parent, label = EXCLUDED.label, unit = EXCLUDED.unit, headline = EXCLUDED.headline`; // ::text first: Bun sends a string cast straight to jsonb as a JSON string
    await this.sql`
      INSERT INTO eia_report_values (event_id, series_id, seq, period_end, value, prior, change, year_ago, year_ago_pct, avg4, avg4_year_ago, five_year, five_year_pct)
      SELECT ${eventId}, x.series_id, x.seq, x.period_end::date, x.value, x.prior, x.change, x.year_ago, x.year_ago_pct, x.avg4, x.avg4_year_ago, x.five_year, x.five_year_pct
      FROM jsonb_to_recordset(${JSON.stringify(values)}::text::jsonb) AS x(series_id text, seq int, period_end text, value double precision, prior double precision, change double precision, year_ago double precision, year_ago_pct double precision, avg4 double precision, avg4_year_ago double precision, five_year double precision, five_year_pct double precision)
      ON CONFLICT (event_id, series_id) DO UPDATE SET seq = EXCLUDED.seq, value = EXCLUDED.value, prior = EXCLUDED.prior, change = EXCLUDED.change, year_ago = EXCLUDED.year_ago,
        year_ago_pct = EXCLUDED.year_ago_pct, avg4 = EXCLUDED.avg4, avg4_year_ago = EXCLUDED.avg4_year_ago, five_year = EXCLUDED.five_year, five_year_pct = EXCLUDED.five_year_pct`;
    await this.events.markReleased(eventId, storedAt);
    await this.sql`
      INSERT INTO eia_report_arrivals (event_id, official_release_at, first_stored_at, delay_ms, rows, backfilled)
      VALUES (${eventId}, ${iso(officialAt)}, ${iso(storedAt)}, ${Math.max(0, storedAt - officialAt)}, ${report.rows.length}, ${storedAt - officialAt > 30 * 60_000})
      ON CONFLICT (event_id) DO NOTHING`; // the first storing is the arrival; a later correction does not change it
    return report.rows.length;
  }

  /** The newest stored report of a kind (or of a given week) with its rows in the file's order. */
  async latest(report: EiaReportCode, week?: string): Promise<StoredReport | undefined> {
    const ev = (await this.sql`
      SELECT e.id, e.key, e.scheduled_at, a.official_release_at, a.first_stored_at, a.delay_ms, a.backfilled
      FROM economic_events e LEFT JOIN eia_report_arrivals a ON a.event_id = e.id
      WHERE e.series_code = ${report} AND EXISTS (SELECT 1 FROM eia_report_values v WHERE v.event_id = e.id) AND (${week ?? null}::text IS NULL OR e.key = ${week ?? null})
      ORDER BY e.key DESC LIMIT 1`) as { id: string | number; key: string; scheduled_at: Date; official_release_at: Date | null; first_stored_at: Date | null; delay_ms: string | number | null; backfilled: boolean | null }[];
    if (!ev[0]) return undefined;
    const id = Number(ev[0].id);
    const rows = (await this.sql`
      SELECT s.id, s.report, s.table_id, s.grp, s.parent, s.label, s.unit, s.headline, v.seq, v.period_end, v.value, v.prior, v.change, v.year_ago, v.year_ago_pct, v.avg4, v.avg4_year_ago, v.five_year, v.five_year_pct
      FROM eia_report_values v JOIN eia_series s ON s.id = v.series_id WHERE v.event_id = ${id} ORDER BY v.seq, s.id`) as Record<string, any>[];
    const opt = (n: unknown) => (n === null || n === undefined ? undefined : Number(n));
    return {
      eventId: id,
      report,
      weekEnding: ev[0].key,
      scheduledAt: new Date(ev[0].scheduled_at).getTime(),
      officialReleaseAt: ev[0].official_release_at ? new Date(ev[0].official_release_at).getTime() : undefined,
      firstStoredAt: ev[0].first_stored_at ? new Date(ev[0].first_stored_at).getTime() : undefined,
      delayMs: opt(ev[0].delay_ms),
      backfilled: ev[0].backfilled ?? undefined,
      rows: rows.map((r) => ({
        seriesId: r.id,
        report: r.report,
        table: r.table_id,
        group: r.grp,
        parent: r.parent,
        label: r.label,
        unit: r.unit,
        seq: Number(r.seq ?? 0),
        periodEnd: new Date(r.period_end).getTime(),
        value: Number(r.value),
        prior: opt(r.prior),
        change: opt(r.change),
        yearAgo: opt(r.year_ago),
        yearAgoPct: opt(r.year_ago_pct),
        avg4: opt(r.avg4),
        avg4YearAgo: opt(r.avg4_year_ago),
        fiveYear: opt(r.five_year),
        fiveYearPct: opt(r.five_year_pct),
        headline: Boolean(r.headline),
      })),
    };
  }

  /** The newest forecast figure recorded for a release (Forex Factory's, or one typed in), as a number. */
  async forecastFor(eventId: number): Promise<{ value: number; source: string } | undefined> {
    const r = (await this.sql`SELECT value_num, source FROM event_observations WHERE event_id = ${eventId} AND kind = 'forecast' AND value_num IS NOT NULL ORDER BY observed_at DESC, id DESC LIMIT 1`) as { value_num: number; source: string }[];
    return r[0] && { value: Number(r[0].value_num), source: r[0].source };
  }

  /** The last arrivals, newest first: what the delay log shows. */
  async arrivals(limit = 20) {
    return (await this.sql`
      SELECT e.series_code AS report, e.key AS "weekEnding", a.official_release_at AS "officialReleaseAt", a.first_stored_at AS "firstStoredAt", a.delay_ms::double precision AS "delayMs", a.rows, a.backfilled
      FROM eia_report_arrivals a JOIN economic_events e ON e.id = a.event_id ORDER BY a.first_stored_at DESC LIMIT ${limit}`) as Record<string, unknown>[];
  }
}
