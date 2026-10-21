import type { SQL } from "bun";
import { LruCache, optionKey, type Chain, type OiBaseline } from "@drishti/shared";

const RECORD_EVERY_MS = 2 * 60_000; // snapshots per chain are written at most this often
const BASELINE_TTL_MS = 60_000; // baselines change only when a session turns over or a new first reading is stored

/** Trading day in IST (MCX), as YYYY-MM-DD. */
export const istDay = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);

/**
 * Open-interest snapshots per option contract and day (Postgres `option_oi`). Upstox has no previous-day OI for MCX options, so the
 * baseline for "OI change" is our own: the last reading of the previous session, or (until we have one) this session's first reading.
 * Never throws: without a database the chain simply has no change column.
 */
export class OiStore {
  private readonly lastRecord = new LruCache<number>(64);
  private readonly baselines = new LruCache<{ at: number; map: Map<string, OiBaseline> }>(64);

  constructor(private readonly sql: SQL) {}

  async baseline(chain: Pick<Chain, "underlying" | "expiry">, now = Date.now()): Promise<Map<string, OiBaseline>> {
    const id = `${chain.underlying}|${chain.expiry}`;
    const hit = this.baselines.get(id);
    if (hit && now - hit.at < BASELINE_TTL_MS) return hit.map;
    const day = istDay(now);
    const map = new Map<string, OiBaseline>();
    try {
      const today = (await this.sql`SELECT key, first_oi FROM option_oi WHERE day = ${day}::date AND underlying = ${chain.underlying} AND expiry = ${chain.expiry}::date`) as { key: string; first_oi: number }[];
      for (const r of today) map.set(r.key, { first: r.first_oi });
      const before = (await this.sql`SELECT DISTINCT ON (key) key, last_oi FROM option_oi WHERE day < ${day}::date AND underlying = ${chain.underlying} AND expiry = ${chain.expiry}::date ORDER BY key, day DESC`) as { key: string; last_oi: number }[];
      for (const r of before) map.set(r.key, { ...map.get(r.key), prev: r.last_oi });
    } catch {
      /* no database: no change column */
    }
    this.baselines.set(id, { at: now, map });
    return map;
  }

  /** Store today's OI for every leg that has one (first reading kept, last reading updated). Throttled per chain. */
  async record(chain: Chain, now = Date.now()): Promise<void> {
    const id = `${chain.underlying}|${chain.expiry}`;
    if (now - (this.lastRecord.get(id) ?? 0) < RECORD_EVERY_MS) return;
    const rows = chain.rows.flatMap((r) =>
      (["CE", "PE"] as const).flatMap((side) => {
        const leg = side === "CE" ? r.ce : r.pe;
        return leg?.oi === undefined ? [] : [{ key: optionKey(chain.underlying, chain.expiry, r.strike, side), underlying: chain.underlying, expiry: chain.expiry, strike: r.strike, side, oi: leg.oi }];
      }),
    );
    if (rows.length === 0) return; // a TradingView-only chain has no OI: nothing to store
    this.lastRecord.set(id, now);
    try {
      await this.sql`
        INSERT INTO option_oi (day, key, underlying, expiry, strike, side, first_oi, last_oi)
        SELECT ${istDay(now)}::date, x.key, x.underlying, x.expiry, x.strike, x.side, x.oi, x.oi
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS x(key text, underlying text, expiry date, strike double precision, side text, oi double precision)
        ON CONFLICT (day, key) DO UPDATE SET last_oi = EXCLUDED.last_oi, updated_at = now()`; // ::text first: Bun sends a string param cast straight to jsonb as a JSON string
    } catch {
      this.lastRecord.set(id, 0); // try again on the next chain
    }
  }
}
