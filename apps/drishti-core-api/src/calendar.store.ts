import type { SQL } from "bun";
import type { EiaReportPoint, EventSeriesDef, EventStore, ObservationIn, PlannedEvent, StoredEventRef } from "@drishti/shared";

const at = (ms: number) => new Date(ms).toISOString();
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The stored economic calendar over Postgres (tables in infra/sql/014_economic_calendar.sql). */
export class PgEventStore implements EventStore {
  constructor(private readonly sql: SQL) {}

  async upsertSeries(d: EventSeriesDef) {
    await this.sql`
      INSERT INTO event_series (code, title, category, country, importance, frequency, detail, relevance, source, schedule)
      VALUES (${d.code}, ${d.title}, ${d.category}, ${d.country}, ${d.importance}, ${d.frequency}, ${d.detail}, ${`{${d.relevance.join(",")}}`}::text[], ${d.source}, ${JSON.stringify(d.schedule)}::text::jsonb)
      ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, category = EXCLUDED.category, country = EXCLUDED.country, importance = EXCLUDED.importance,
        frequency = EXCLUDED.frequency, detail = EXCLUDED.detail, relevance = EXCLUDED.relevance, source = EXCLUDED.source, schedule = EXCLUDED.schedule, updated_at = now()`;
  }

  async stored(from: number, to: number): Promise<StoredEventRef[]> {
    const rows = (await this.sql`SELECT id, series_code, key, scheduled_at, status FROM economic_events WHERE scheduled_at >= ${at(from)} AND scheduled_at < ${at(to)}`) as { id: string | number; series_code: string; key: string; scheduled_at: Date; status: string }[];
    return rows.map((r) => ({ id: Number(r.id), seriesCode: r.series_code, key: r.key, scheduledAt: new Date(r.scheduled_at).getTime(), status: r.status }));
  }

  async insertEvent(p: PlannedEvent) {
    const rows = (await this.sql`
      INSERT INTO economic_events (series_code, key, scheduled_at, original_scheduled_at, title, period)
      VALUES (${p.series.code}, ${p.key}, ${at(p.at)}, ${at(p.at)}, ${p.title}, ${p.period ?? null})
      ON CONFLICT (series_code, key) DO UPDATE SET title = EXCLUDED.title
      RETURNING id`) as { id: string | number }[];
    return Number(rows[0].id);
  }

  async moveEvent(id: number, when: number) {
    await this.sql`UPDATE economic_events SET scheduled_at = ${at(when)} WHERE id = ${id} AND status <> 'released'`;
  }

  async addObservations(id: number, obs: ObservationIn[]) {
    let fresh = 0;
    for (const o of obs) {
      const rows = (await this.sql`
        INSERT INTO event_observations (event_id, kind, value_text, value_num, unit, source)
        VALUES (${id}, ${o.kind}, ${o.text}, ${o.num ?? null}, ${o.unit ?? null}, ${o.source})
        ON CONFLICT (event_id, kind, value_text, source) DO NOTHING RETURNING id`) as unknown[];
      fresh += rows.length;
    }
    return fresh;
  }

  async markReleased(id: number, when: number) {
    await this.sql`UPDATE economic_events SET status = 'released', released_at = ${at(when)} WHERE id = ${id} AND status <> 'released'`;
  }

  /** Releases of the two EIA reports that are out but have no table stored yet. */
  async needingTables(report: "WPSR" | "WNGSR"): Promise<{ id: number; scheduledAt: number }[]> {
    const rows = (await this.sql`
      SELECT e.id, e.scheduled_at FROM economic_events e
      WHERE e.series_code = ${report} AND e.scheduled_at <= now() AND e.scheduled_at > now() - interval '3 days'
        AND NOT EXISTS (SELECT 1 FROM eia_report_values v WHERE v.event_id = e.id)`) as { id: string | number; scheduled_at: Date }[];
    return rows.map((r) => ({ id: Number(r.id), scheduledAt: new Date(r.scheduled_at).getTime() }));
  }

  /** Stores every figure of an EIA report against its event (idempotent). */
  async saveEiaTable(report: "WPSR" | "WNGSR", eventId: number, points: EiaReportPoint[]) {
    for (const p of points) {
      await this.sql`INSERT INTO eia_series (id, report, label, unit, headline) VALUES (${p.seriesId}, ${report}, ${p.label}, ${p.unit}, ${p.headline}) ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, unit = EXCLUDED.unit, headline = EXCLUDED.headline`;
      await this.sql`
        INSERT INTO eia_report_values (event_id, series_id, period_end, value, prior, change)
        VALUES (${eventId}, ${p.seriesId}, ${isoDay(p.periodEnd)}::date, ${p.value}, ${p.prior ?? null}, ${p.change ?? null})
        ON CONFLICT (event_id, series_id) DO NOTHING`;
    }
  }

  /** What is stored for the events in a window, newest first, with every observation in the order it was seen. */
  async list(from: number, to: number, series?: string) {
    const rows = (await this.sql`
      SELECT e.id, e.series_code, e.key, e.scheduled_at, e.original_scheduled_at, e.title, e.period, e.status, e.released_at,
        COALESCE((SELECT json_agg(json_build_object('kind', o.kind, 'text', o.value_text, 'num', o.value_num, 'unit', o.unit, 'source', o.source, 'observedAt', o.observed_at, 'backfilled', o.backfilled) ORDER BY o.observed_at, o.id)
                  FROM event_observations o WHERE o.event_id = e.id), '[]'::json) AS observations
      FROM economic_events e
      WHERE e.scheduled_at >= ${at(from)} AND e.scheduled_at < ${at(to)} AND (${series ?? null}::text IS NULL OR e.series_code = ${series ?? null})
      ORDER BY e.scheduled_at DESC LIMIT 500`) as Record<string, unknown>[];
    return rows;
  }

  async eiaValues(eventId: number) {
    return (await this.sql`SELECT s.id AS "seriesId", s.label, s.unit, s.headline, v.period_end AS "periodEnd", v.value, v.prior, v.change FROM eia_report_values v JOIN eia_series s ON s.id = v.series_id WHERE v.event_id = ${eventId} ORDER BY s.headline DESC, s.id`) as Record<string, unknown>[];
  }
}
