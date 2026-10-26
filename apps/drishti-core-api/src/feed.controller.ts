import { BadRequestException, Controller, Get, NotFoundException, Query, ServiceUnavailableException } from "@nestjs/common";
import { coverage, recordedChain, type SnapshotContract } from "@drishti/shared";
import { Db } from "./db";

const FUTURE_KEY = /^MCX:[A-Z]{3,20}$/;
const UPSTOX_KEY = /^MCX_FO\|\d{3,8}$/;
const UNDERLYINGS = ["CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 20_000;
const MAX_SPAN_MS = 2 * 86_400_000;
const IST = "+05:30";

const instant = (v: string | undefined, name: string) => {
  const ms = v === undefined ? NaN : /^\d{10,13}$/.test(v) ? Number(v) * (v.length <= 10 ? 1000 : 1) : Date.parse(v);
  if (!Number.isFinite(ms)) throw new BadRequestException(`${name} must be an ISO time (2026-10-26T21:00:00+05:30) or epoch seconds`);
  return ms;
};
const unavailable = () => {
  throw new ServiceUnavailableException("the database is not available");
};

/**
 * Reads back what the Upstox capture stored (stream: feedRecorder, upstoxCapture): the live feed rows, the chain at a point in time, and how much of a
 * session the recording covers. Read-only; every input is validated before a query and every result is bounded.
 */
@Controller("feed")
export class FeedController {
  constructor(private readonly db: Db) {}

  /** What is stored and how big. GET /feed/status */
  @Get("status")
  async status() {
    const sql = this.db.sql;
    const one = async (q: Promise<any[]>) => (await q)[0];
    return Promise.all([
      one(sql`SELECT count(*)::bigint AS rows, count(DISTINCT key)::int AS keys, min(time) AS first, max(time) AS last FROM feed_quotes` as Promise<any[]>),
      one(sql`SELECT count(*)::bigint AS rows, count(DISTINCT key)::int AS keys, count(DISTINCT time)::int AS snapshots, min(time) AS first, max(time) AS last FROM quote_snapshots` as Promise<any[]>),
      one(sql`SELECT count(*)::int AS contracts, max(last_seen) AS last_seen FROM contract_master` as Promise<any[]>),
      one(sql`SELECT pg_size_pretty(coalesce(hypertable_size('feed_quotes'), 0)) AS feed_quotes, pg_size_pretty(coalesce(hypertable_size('quote_snapshots'), 0)) AS quote_snapshots` as Promise<any[]>),
    ])
      .then(([feed, snaps, master, size]) => ({ feedQuotes: feed, quoteSnapshots: snaps, contractMaster: master, size }))
      .catch(unavailable);
  }

  /** The recorded feed of one contract, oldest first. GET /feed/quotes?key=MCX:CRUDEOIL|MCX_FO|582934&from=...&to=...&limit=5000 (a window of at most 2 days) */
  @Get("quotes")
  async quotes(@Query("key") key?: string, @Query("from") fromParam?: string, @Query("to") toParam?: string, @Query("limit") limitParam?: string) {
    if (!key || !(FUTURE_KEY.test(key) || UPSTOX_KEY.test(key))) throw new BadRequestException("key must look like MCX:CRUDEOIL or MCX_FO|582934");
    const from = instant(fromParam, "from");
    const to = instant(toParam, "to");
    if (to <= from) throw new BadRequestException("to must be after from");
    if (to - from > MAX_SPAN_MS) throw new BadRequestException("at most 2 days at a time");
    const limit = limitParam === undefined ? 5000 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new BadRequestException(`limit must be 1 to ${MAX_ROWS}`);
    return this.db.sql`
      SELECT extract(epoch FROM time)::float8 AS time, extract(epoch FROM trade_at)::float8 AS "tradeAt", price, volume, bid, ask, bid_qty AS "bidQty", ask_qty AS "askQty",
             oi, atp, ltq, total_buy_qty AS "totalBuyQty", total_sell_qty AS "totalSellQty", prev_close AS "prevClose", depth, iv, delta, theta, gamma, vega
      FROM feed_quotes WHERE key = ${key} AND time >= ${new Date(from).toISOString()} AND time < ${new Date(to).toISOString()} ORDER BY time LIMIT ${limit}`.catch(unavailable);
  }

  /**
   * The whole chain of one underlying at a point in time: the latest snapshot at or before `at`, one row per contract with strike, side, expiry,
   * price, bid/ask depth, OI, volume, circuit limits and greeks. GET /feed/chain?underlying=CRUDEOIL&expiry=2026-11-17&at=2026-10-26T21:00:00+05:30
   * (`expiry` optional, futures listed with side FUT; `at` defaults to now).
   */
  @Get("chain")
  async chain(@Query("underlying") underlying?: string, @Query("expiry") expiry?: string, @Query("at") atParam?: string) {
    if (!underlying || !UNDERLYINGS.includes(underlying)) throw new BadRequestException(`underlying must be one of ${UNDERLYINGS}`);
    if (expiry !== undefined && !DAY.test(expiry)) throw new BadRequestException("expiry must be YYYY-MM-DD");
    const at = atParam === undefined ? Date.now() : instant(atParam, "at");
    const sql = this.db.sql;
    const snap = (await sql`SELECT max(time) AS t FROM quote_snapshots WHERE time <= ${new Date(at).toISOString()}`.catch(unavailable)) as { t: Date | null }[];
    const t = snap[0]?.t;
    if (!t) return { at: null, contracts: [] };
    const rows = await sql`
      SELECT c.key, c.symbol, c.kind AS side, c.expiry::text AS expiry, c.strike, c.lot,
             s.last_price AS "lastPrice", extract(epoch FROM s.last_trade_at)::float8 AS "lastTradeAt", s.ltq, s.volume, s.average_price AS "averagePrice", s.oi, s.oi_day_high AS "oiDayHigh", s.oi_day_low AS "oiDayLow",
             s.net_change AS "netChange", s.prev_close AS "prevClose", s.open, s.high, s.low, s.close, s.total_buy_qty AS "totalBuyQty", s.total_sell_qty AS "totalSellQty",
             s.lower_circuit AS "lowerCircuit", s.upper_circuit AS "upperCircuit", s.depth, s.iv, s.delta, s.theta, s.gamma, s.vega
      FROM quote_snapshots s JOIN contract_master c ON c.key = s.key
      WHERE s.time = ${t} AND c.underlying = ${underlying} AND (${expiry ?? null}::date IS NULL OR c.expiry = ${expiry ?? null}::date)
      ORDER BY c.expiry, c.strike, c.kind`.catch(unavailable);
    return { at: new Date(t).getTime(), contracts: rows };
  }

  /**
   * The same chain the live panel draws, read back from the snapshots: GET /feed/chain-view?underlying=CRUDEOIL&expiry=2026-11-17&at=2026-10-26T21:00:00+05:30&strikes=10
   * (the latest snapshot at or before `at`; `prevAt` / `nextAt` are the neighbouring snapshots, to step through them; OI change is against the first
   * snapshot of the same IST day). 404 when nothing was recorded by then.
   */
  @Get("chain-view")
  async chainView(@Query("underlying") underlying?: string, @Query("expiry") expiry?: string, @Query("at") atParam?: string, @Query("strikes") strikesParam?: string) {
    if (!underlying || !UNDERLYINGS.includes(underlying)) throw new BadRequestException(`underlying must be one of ${UNDERLYINGS}`);
    if (expiry !== undefined && expiry !== "" && !DAY.test(expiry)) throw new BadRequestException("expiry must be YYYY-MM-DD");
    const each = strikesParam === undefined ? 10 : Number(strikesParam);
    if (!Number.isInteger(each) || each < 4 || each > 40) throw new BadRequestException("strikes must be 4 to 40");
    const at = atParam === undefined || atParam === "" ? Date.now() : instant(atParam, "at");
    const sql = this.db.sql;
    const [snap] = (await sql`SELECT max(time) AS t FROM quote_snapshots WHERE time <= ${new Date(at).toISOString()}`.catch(unavailable)) as { t: Date | null }[];
    if (!snap?.t) throw new NotFoundException("no snapshot was recorded by then");
    const t = new Date(snap.t);
    const istMidnight = new Date(Math.floor((t.getTime() + 5.5 * 3600_000) / 86_400_000) * 86_400_000 - 5.5 * 3600_000);
    const [[prev], [next], [first]] = (await Promise.all([
      sql`SELECT max(time) AS t FROM quote_snapshots WHERE time < ${t.toISOString()}`,
      sql`SELECT min(time) AS t FROM quote_snapshots WHERE time > ${t.toISOString()}`,
      sql`SELECT min(time) AS t FROM quote_snapshots WHERE time >= ${istMidnight.toISOString()}`,
    ]).catch(unavailable)) as { t: Date | null }[][];
    const load = (when: Date) => sql`
      SELECT c.key, c.kind AS side, c.expiry::text AS expiry, c.strike, c.lot, c.raw->>'underlying_key' AS "underlyingKey",
             s.last_price AS "lastPrice", s.net_change AS "netChange", s.oi, s.volume, s.iv, s.delta, s.theta, s.gamma, s.vega,
             s.lower_circuit AS "lowerCircuit", s.upper_circuit AS "upperCircuit", s.depth
      FROM quote_snapshots s JOIN contract_master c ON c.key = s.key
      WHERE s.time = ${when.toISOString()} AND c.underlying = ${underlying}`;
    const rows = (await load(t).catch(unavailable)) as SnapshotContract[];
    const firstAt = first?.t ? new Date(first.t) : undefined;
    const baseline =
      firstAt && firstAt.getTime() < t.getTime()
        ? new Map(((await load(firstAt).catch(unavailable)) as SnapshotContract[]).flatMap((r) => (r.oi === null || r.oi === undefined ? [] : [[r.key, Number(r.oi)] as [string, number]])))
        : undefined;
    const chain = recordedChain({ underlying, expiry: expiry || undefined, asOf: t.getTime(), rows, baseline, strikesEachSide: each, prevAt: prev?.t ? new Date(prev.t).getTime() : null, nextAt: next?.t ? new Date(next.t).getTime() : null });
    if (!chain) throw new NotFoundException("that snapshot holds no options for this underlying");
    return chain;
  }

  /**
   * Contracts we hold candles for, expired ones included: GET /feed/contracts?underlying=CRUDEOIL[&expiry=2026-11-17][&side=CE]. Newest expiry first, at most 3,000.
   * This is the only list of an expired MCX contract anywhere: Upstox's expired-contract API has none.
   */
  @Get("contracts")
  async contracts(@Query("underlying") underlying?: string, @Query("expiry") expiry?: string, @Query("side") side?: string) {
    if (!underlying || !UNDERLYINGS.includes(underlying)) throw new BadRequestException(`underlying must be one of ${UNDERLYINGS}`);
    if (expiry !== undefined && expiry !== "" && !DAY.test(expiry)) throw new BadRequestException("expiry must be YYYY-MM-DD");
    if (side !== undefined && side !== "" && !["CE", "PE", "FUT"].includes(side)) throw new BadRequestException("side must be CE, PE or FUT");
    return this.db.sql`
      SELECT key, symbol, expiry::text AS expiry, strike, side, lot FROM option_contracts
      WHERE underlying = ${underlying} AND (${expiry || null}::date IS NULL OR expiry = ${expiry || null}::date) AND (${side || null}::text IS NULL OR side = ${side || null}::text)
      ORDER BY expiry DESC, strike, side LIMIT 3000`.catch(unavailable);
  }

  /** How much of one MCX day the recording covers: minutes with Upstox messages against the official session window, and the holes. GET /feed/coverage?day=2026-10-26 */
  @Get("coverage")
  async coverage(@Query("day") day?: string) {
    if (!day || !DAY.test(day)) throw new BadRequestException("day must be YYYY-MM-DD (IST)");
    const sql = this.db.sql;
    const [win] = (await sql`SELECT start_at, end_at FROM market_days WHERE day = ${day}::date AND exchange = 'MCX'`.catch(unavailable)) as { start_at: Date; end_at: Date }[];
    // without the official window (a day before the capture existed) the weekday rule's 09:00 to 23:30 IST is used and the answer says so
    const start = win ? new Date(win.start_at).getTime() : Date.parse(`${day}T09:00:00${IST}`);
    const end = win ? new Date(win.end_at).getTime() : Date.parse(`${day}T23:30:00${IST}`);
    const present = (await sql`
      SELECT extract(epoch FROM minute)::float8 * 1000 AS t FROM feed_minutes WHERE minute >= ${new Date(start).toISOString()} AND minute < ${new Date(end).toISOString()} AND upstox_msgs > 0`.catch(unavailable)) as { t: number }[];
    // a session still running is judged only up to now: the minutes that have not happened yet are not holes
    const c = coverage(present.map((r) => r.t), start, Math.min(end, Date.now()));
    return { day, window: { from: start, to: end, official: Boolean(win) }, ...c };
  }
}
