import type { SQL } from "bun";
import { expiryDate, type Bar, type OptionContract } from "@drishti/shared";

const CHUNK = 2000; // rows per INSERT (8 parameters each, far below Postgres's 65,535)
const LAST_RUN = "option_candles_last_run";

export interface OptionCandleStatus {
  contracts: number;
  candles: number;
  firstTime: number | null;
  lastTime: number | null;
  lastRunAt: number | null;
}

/** Postgres `option_contracts` and `option_candles` (infra/sql/013): append-only copies of live option candles. */
export class OptionCandleStore {
  constructor(private readonly sql: SQL) {}

  async lastRunAt(): Promise<number | undefined> {
    const r = (await this.sql`SELECT value FROM kv WHERE key = ${LAST_RUN}`) as { value: string }[];
    const n = Number(r[0]?.value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  async setLastRun(ms: number): Promise<void> {
    await this.sql`INSERT INTO kv (key, value) VALUES (${LAST_RUN}, ${String(ms)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  }

  async upsertContracts(contracts: OptionContract[]): Promise<void> {
    if (!contracts.length) return;
    const rows = contracts.map((c) => ({ key: c.instrument_key, symbol: c.trading_symbol, underlying: c.underlying_symbol, expiry: expiryDate(c.expiry), strike: c.strike_price, side: c.instrument_type, lot: c.lot_size ?? null }));
    await this.sql`INSERT INTO option_contracts ${this.sql(rows)} ON CONFLICT (key) DO NOTHING`;
  }

  async insertCandles(key: string, bars: Bar[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < bars.length; i += CHUNK) {
      const rows = bars.slice(i, i + CHUNK).map((b) => ({ key, time: new Date(b.time * 1000), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, oi: b.oi ?? null }));
      const res = (await this.sql`INSERT INTO option_candles ${this.sql(rows)} ON CONFLICT (key, time) DO NOTHING RETURNING time`) as unknown[];
      inserted += res.length;
    }
    return inserted;
  }

  async status(): Promise<OptionCandleStatus> {
    const r = (await this.sql`SELECT (SELECT count(*)::int FROM option_contracts) AS contracts, count(*)::int AS candles, extract(epoch FROM min(time))::float8 AS first, extract(epoch FROM max(time))::float8 AS last FROM option_candles`) as any[];
    return { contracts: r[0].contracts, candles: r[0].candles, firstTime: r[0].first, lastTime: r[0].last, lastRunAt: (await this.lastRunAt()) ?? null };
  }

  /** Candles of one contract between two instants (epoch seconds), oldest first. */
  async candles(key: string, from: number, to: number, limit: number): Promise<Bar[]> {
    const rows = (await this.sql`SELECT extract(epoch FROM time)::float8 AS time, open, high, low, close, volume, oi FROM option_candles WHERE key = ${key} AND time >= ${new Date(from * 1000)} AND time <= ${new Date(to * 1000)} ORDER BY time LIMIT ${limit}`) as (Bar & { oi: number | null })[];
    return rows.map(({ oi, ...bar }) => (oi === null ? bar : { ...bar, oi }));
  }
}
