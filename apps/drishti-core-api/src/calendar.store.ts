import type { SQL } from "bun";
import type { EventSeriesDef, EventStore, ObservationIn, PlannedEvent, StoredEventRef } from "@drishti/shared";

const at = (ms: number) => new Date(ms).toISOString();

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
    return (await this.sql`
      SELECT s.id AS "seriesId", s.table_id AS "table", s.grp AS "group", s.parent, s.label, s.unit, s.headline, v.seq, v.period_end AS "periodEnd", v.value, v.prior, v.change,
        v.year_ago AS "yearAgo", v.year_ago_pct AS "yearAgoPct", v.avg4, v.avg4_year_ago AS "avg4YearAgo", v.five_year AS "fiveYear", v.five_year_pct AS "fiveYearPct"
      FROM eia_report_values v JOIN eia_series s ON s.id = v.series_id WHERE v.event_id = ${eventId} ORDER BY v.seq, s.id`) as Record<string, unknown>[];
  }
}
