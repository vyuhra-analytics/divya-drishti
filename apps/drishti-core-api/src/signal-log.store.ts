import type { SQL } from "bun";
import type { SignalRecord } from "@drishti/shared";

/** A logged evening with the paper trade it led to, when there was one. */
export interface LoggedSignalRow {
  record: SignalRecord;
  evaluatedAt: number;
  trade?: { id: string; account: string; side: string; entry: number; exit?: number; net?: number; rMultiple?: number; reason?: string; open: boolean };
}

/** The signal log over Postgres (migration 028): append-only, the first evaluation of an evening wins. */
export class PgSignalStore {
  constructor(private readonly sql: SQL) {}

  async has(key: string): Promise<boolean> {
    return ((await this.sql`SELECT 1 FROM signal_log WHERE key = ${key}`) as unknown[]).length > 0;
  }

  /** Store a record unless the evening is already logged. Returns whether it was new. */
  async add(r: SignalRecord): Promise<boolean> {
    const rows = (await this.sql`
      INSERT INTO signal_log (key, strategy, symbol, at, status, record)
      VALUES (${r.key}, ${r.strategy}, ${r.symbol}, ${new Date(r.at).toISOString()}, ${r.status}, ${JSON.stringify(r)}::text::jsonb)
      ON CONFLICT (key) DO NOTHING RETURNING key`) as unknown[];
    return rows.length > 0;
  }

  /** The newest evenings first, each with the paper trade (closed or still open) whose signal time is the signal's candle close and whose strategy matches. */
  async list(limit: number, strategy?: string): Promise<LoggedSignalRow[]> {
    const rows = (await this.sql`
      SELECT record, extract(epoch FROM evaluated_at)::float8 * 1000 AS evaluated_at FROM signal_log
      WHERE (${strategy ?? null}::text IS NULL OR strategy = ${strategy ?? null}) ORDER BY at DESC LIMIT ${limit}`) as { record: SignalRecord; evaluated_at: number }[];
    const out: LoggedSignalRow[] = [];
    for (const r of rows) {
      const closedAt = r.record.signal?.closedAt;
      let trade: LoggedSignalRow["trade"];
      if (closedAt !== undefined) {
        const ms = Math.round(closedAt * 1000);
        const closed = (await this.sql`
          SELECT id, account, data FROM paper_trades WHERE data->>'strategy' = ${r.record.strategy} AND (data->>'signalTime')::float8 = ${ms} ORDER BY closed_at DESC LIMIT 1`.catch(() => [])) as { id: string; account: string; data: any }[];
        if (closed[0]) {
          const d = closed[0].data;
          trade = { id: closed[0].id, account: closed[0].account, side: d.side, entry: d.entry, exit: d.exit, net: d.net, rMultiple: d.rMultiple, reason: d.reason, open: false };
        } else {
          const open = (await this.sql`
            SELECT id, account, data FROM paper_positions WHERE data->>'strategy' = ${r.record.strategy} AND (data->>'signalTime')::float8 = ${ms} LIMIT 1`.catch(() => [])) as { id: string; account: string; data: any }[];
          if (open[0]) trade = { id: open[0].id, account: open[0].account, side: open[0].data.side, entry: open[0].data.entry, open: true };
        }
      }
      out.push({ record: r.record, evaluatedAt: Math.round(Number(r.evaluated_at)), ...(trade ? { trade } : {}) });
    }
    return out;
  }
}
