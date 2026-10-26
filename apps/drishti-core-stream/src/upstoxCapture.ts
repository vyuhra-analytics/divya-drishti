// Everything else Upstox will tell us about our MCX contracts, copied to Postgres because it cannot be asked for after the session
// (infra/sql/020_upstox_capture.sql):
//   quote_snapshots  the whole chain (every future and option of CRUDEOIL, CRUDEOILM, NATURALGAS, NATGASMINI) from the REST full quote + option
//                    greeks, every 15 minutes while MCX is open and once after the close: circuit limits, OI day high/low, order counts per level
//   contract_master  the daily instrument file, so past strikes, expiries and lot sizes can be rebuilt
//   market_days      each day's official session times;  market_log  every change of the exchange's own status
// Rate use: about 70 requests per snapshot against Upstox's 50 a second / 500 a minute, three at a time.
import type { SQL } from "bun";
import { mapLimit, pieces, shouldRecord, snapshotRows, type MarketStatus, type SnapshotRow } from "@drishti/shared";
import { loadOurContractRows } from "./contracts";

const API = "https://api.upstox.com";
const SNAPSHOT_EVERY_MS = 15 * 60_000;
const QUOTES_PER_CALL = 250; // the docs allow 500; the key list rides in the URL
const GREEKS_PER_CALL = 50;
const MASTER_EVERY_MS = 6 * 3600_000;
const IST = 5.5 * 3600_000;
const istDay = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);

export interface CaptureStats {
  snapshots: number;
  lastSnapshotAt: number | null;
  lastSnapshotRows: number;
  lastError?: string;
  contractsKnown: number;
}

export function startUpstoxCapture(sql: SQL, deps: { token: () => Promise<string | null>; mcxOpen: () => boolean }) {
  const stats: CaptureStats = { snapshots: 0, lastSnapshotAt: null, lastSnapshotRows: 0, contractsKnown: 0 };
  let running = false;
  let lastStatus: string | undefined;

  const get = async (token: string, path: string) => {
    // a rate-limit answer (429) is waited out, up to three times: Upstox allows 2,000 requests in 30 minutes for everything the app does
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API}${path}`, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`${path.split("?")[0]} ${res.status}`);
      return ((await res.json()) as any)?.data ?? {};
    }
  };

  async function snapshot(now: number) {
    const token = await deps.token();
    if (!token) return;
    const contracts = await loadOurContractRows(now);
    stats.contractsKnown = contracts.length;
    const keys = contracts.map((r) => r.instrument_key as string);
    const optionKeys = contracts.filter((r) => r.instrument_type === "CE" || r.instrument_type === "PE").map((r) => r.instrument_key as string);
    const q = (list: string[]) => list.map(encodeURIComponent).join(",");
    const quotePieces = pieces(keys, QUOTES_PER_CALL);
    let failed = 0;
    const quotes: Record<string, any> = {};
    const greeks: Record<string, any> = {};
    await mapLimit(quotePieces, 3, async (p) => {
      try {
        Object.assign(quotes, await get(token, `/v2/market-quote/quotes?instrument_key=${q(p)}`));
      } catch (e) {
        failed++;
        stats.lastError = `snapshot: ${(e as Error).message}`;
      }
    });
    await mapLimit(pieces(optionKeys, GREEKS_PER_CALL), 3, async (p) => {
      try {
        Object.assign(greeks, await get(token, `/v3/market-quote/option-greek?instrument_key=${q(p)}`));
      } catch (e) {
        stats.lastError = `greeks: ${(e as Error).message}`; // the quotes are still worth keeping without their greeks
      }
    });
    if (failed > quotePieces.length * 0.2) return; // too little of the chain: do not count this as a snapshot, try again next minute
    const rows = snapshotRows(now, quotes, greeks);
    if (!rows.length) return;
    await insertSnapshot(rows);
    stats.snapshots++;
    stats.lastSnapshotAt = now;
    stats.lastSnapshotRows = rows.length;
  }

  async function insertSnapshot(rows: SnapshotRow[]) {
    for (const part of pieces(rows, 1500)) {
      await sql`
        INSERT INTO quote_snapshots (time, key, symbol, last_price, last_trade_at, ltq, volume, average_price, oi, oi_day_high, oi_day_low, net_change, prev_close, open, high, low, close,
                                     total_buy_qty, total_sell_qty, lower_circuit, upper_circuit, depth, iv, delta, theta, gamma, vega)
        SELECT to_timestamp(at / 1000.0), key, symbol, "lastPrice", to_timestamp("lastTradeAt" / 1000.0), ltq, volume, "averagePrice", oi, "oiDayHigh", "oiDayLow", "netChange", "prevClose", open, high, low, close,
               "totalBuyQty", "totalSellQty", "lowerCircuit", "upperCircuit", depth, iv, delta, theta, gamma, vega
        FROM jsonb_to_recordset(${JSON.stringify(part)}::text::jsonb) AS x(
          at double precision, key text, symbol text, "lastPrice" double precision, "lastTradeAt" double precision, ltq double precision, volume double precision,
          "averagePrice" double precision, oi double precision, "oiDayHigh" double precision, "oiDayLow" double precision, "netChange" double precision, "prevClose" double precision,
          open double precision, high double precision, low double precision, close double precision, "totalBuyQty" double precision, "totalSellQty" double precision,
          "lowerCircuit" double precision, "upperCircuit" double precision, depth jsonb, iv double precision, delta double precision, theta double precision,
          gamma double precision, vega double precision)`;
    }
  }

  /** the daily instrument file → contract_master (first and last day each contract was listed) */
  async function recordMaster(now: number) {
    const rows = await loadOurContractRows(now);
    const day = istDay(now);
    const payload = rows.map((r) => ({
      key: r.instrument_key, symbol: r.trading_symbol, underlying: r.underlying_symbol, kind: r.instrument_type,
      expiry: typeof r.expiry === "number" ? istDay(r.expiry) : null, strike: r.strike_price ?? null, lot: r.lot_size ?? null, tick: r.tick_size ?? null, raw: r,
    }));
    for (const part of pieces(payload, 1000)) {
      await sql`
        INSERT INTO contract_master (key, symbol, underlying, kind, expiry, strike, lot, tick, first_seen, last_seen, raw)
        SELECT key, symbol, underlying, kind, expiry::date, strike, lot, tick, ${day}::date, ${day}::date, raw
        FROM jsonb_to_recordset(${JSON.stringify(part)}::text::jsonb) AS x(key text, symbol text, underlying text, kind text, expiry text, strike double precision, lot double precision, tick double precision, raw jsonb)
        ON CONFLICT (key) DO UPDATE SET last_seen = EXCLUDED.last_seen, lot = EXCLUDED.lot, tick = EXCLUDED.tick, raw = EXCLUDED.raw`;
    }
    stats.contractsKnown = rows.length;
  }

  /** today's official session times of every exchange → market_days (one request, once per IST day) */
  async function recordTimings(now: number) {
    const token = await deps.token();
    if (!token) return;
    const day = istDay(now);
    const data = (await get(token, `/v2/market/timings/${day}`)) as { exchange: string; start_time: number; end_time: number }[];
    if (!Array.isArray(data)) return;
    for (const t of data) {
      await sql`
        INSERT INTO market_days (day, exchange, start_at, end_at) VALUES (${day}::date, ${t.exchange}, ${new Date(t.start_time).toISOString()}, ${new Date(t.end_time).toISOString()})
        ON CONFLICT (day, exchange) DO UPDATE SET start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at, fetched_at = now()`;
    }
  }

  let lastMaster = 0;
  let lastTimingsDay = "";
  async function tick() {
    if (running) return;
    running = true;
    const now = Date.now();
    try {
      if (now - lastMaster >= MASTER_EVERY_MS) {
        await recordMaster(now);
        lastMaster = now;
      }
      if (lastTimingsDay !== istDay(now)) {
        await recordTimings(now);
        lastTimingsDay = istDay(now);
      }
      const last = stats.lastSnapshotAt ?? undefined;
      // every 15 minutes while the exchange is open; once after each close (shouldRecord: 10 minutes past it, never twice for one close)
      if ((deps.mcxOpen() && (last === undefined || now - last >= SNAPSHOT_EVERY_MS)) || (!deps.mcxOpen() && shouldRecord(last, now))) await snapshot(now);
    } catch (e) {
      stats.lastError = (e as Error).message;
    } finally {
      running = false;
    }
  }

  // continue the cadence across a restart instead of snapshotting again at once
  sql`SELECT max(time) AS t FROM quote_snapshots`
    .then((r: any) => void (stats.lastSnapshotAt = r?.[0]?.t ? new Date(r[0].t).getTime() : null))
    .catch(() => undefined)
    .finally(() => {
      setInterval(() => void tick(), 60_000);
      setTimeout(() => void tick(), 15_000);
    });

  return {
    stats,
    /** call with each fresh exchange status; a change is logged */
    logStatus(exchange: string, status: MarketStatus | undefined) {
      if (!status || status.state === lastStatus) return;
      lastStatus = status.state;
      void sql`INSERT INTO market_log (exchange, status) VALUES (${exchange}, ${status.state})`.catch((e: Error) => void (stats.lastError = `market_log: ${e.message}`));
    },
  };
}

/**
 * One `feed_minutes` row per minute the stream ran: Upstox messages heard and rows stored in it. `counters` are running totals; the row holds the
 * difference since the last one. A minute the stream was off has no row, and a minute it ran without hearing Upstox has `upstox_msgs = 0`:
 * either way it shows up as a hole in `GET /feed/coverage`.
 */
export function startMinuteLog(sql: SQL, counters: () => { msgs: number; rows: number; failed: number }) {
  let minute = Math.floor(Date.now() / 60_000);
  let prev = counters();
  return setInterval(() => {
    const now = Math.floor(Date.now() / 60_000);
    if (now === minute) return;
    const c = counters();
    const row = { at: new Date(minute * 60_000).toISOString(), msgs: Math.max(0, c.msgs - prev.msgs), rows: Math.max(0, c.rows - prev.rows), failed: Math.max(0, c.failed - prev.failed) };
    minute = now;
    prev = c;
    // ponytail: a failed write loses that minute's row (it then reads as a gap); add a retry only if it ever matters
    void sql`INSERT INTO feed_minutes (minute, upstox_msgs, rows_recorded, failed_inserts) VALUES (${row.at}, ${row.msgs}, ${row.rows}, ${row.failed}) ON CONFLICT (minute) DO UPDATE SET upstox_msgs = EXCLUDED.upstox_msgs, rows_recorded = EXCLUDED.rows_recorded, failed_inserts = EXCLUDED.failed_inserts`.catch(() => undefined);
  }, 5_000);
}
