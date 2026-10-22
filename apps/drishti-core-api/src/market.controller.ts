import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { adjustBackward, instrument, LruCache, SYMBOLS, TIMEFRAMES, type Bar, type Roll, type Timeframe } from "@drishti/shared";
import { Db } from "./db";
import { upstoxHistory, yahooHistory } from "./history";

const CACHE_MS = 30_000; // several panels open the same chart; don't hammer providers
// ponytail: per-process memory cache; move to Redis if the API ever runs as more than one instance
const cache = new LruCache<{ at: number; bars: Bar[] }>(64); // key = validated symbol + timeframe (about 30 combinations); capped anyway

@Controller()
export class MarketController {
  constructor(private readonly db: Db) {}

  @Get("health")
  async health() {
    const [pg, rd] = await Promise.allSettled([this.db.sql`SELECT 1`, this.db.redis.send("PING", [])]);
    return { service: "drishti-core-api", postgres: pg.status === "fulfilled", redis: rd.status === "fulfilled" };
  }

  @Get("symbols")
  symbols() {
    return SYMBOLS;
  }

  @Get("quotes/:symbol")
  async quote(@Param("symbol") symbol: string) {
    const raw = await this.db.redis.get(`quote:${symbol}`);
    if (!raw) throw new NotFoundException(`no quote for ${symbol}`);
    return JSON.parse(raw);
  }

  /**
   * Chart history: provider first (fresh, deep), written through to Timescale; when the provider can't answer
   * (no Upstox login, network down) fall back to what we stored before plus candles built from our own ticks.
   * ?source=db skips the provider and returns that stored history only (used by chart replay).
   * ?adjust=roll back-adjusts stored candles for the MCX contract rolls the stream recorded (continuous series); provider history is one contract already.
   */
  @Get("bars")
  async bars(@Query("symbol") symbol: string, @Query("tf") tf: string = "1m", @Query("source") source?: string, @Query("adjust") adjust?: string): Promise<Bar[]> {
    const inst = instrument(symbol);
    if (!inst) throw new BadRequestException(`unknown symbol ${symbol}`);
    if (!(tf in TIMEFRAMES)) throw new BadRequestException(`tf must be one of ${Object.keys(TIMEFRAMES)}`);
    // source=db: only what we have stored (replay: a fixed past, no provider call, no write-through)
    const stored = () => this.fromDb(symbol, tf as Timeframe).then((b) => (adjust === "roll" ? this.adjusted(symbol, b) : b)).catch(() => []);
    if (source === "db") return stored();
    const key = `${symbol}|${tf}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.bars;

    const bars = await (inst.yahoo ? yahooHistory(inst, tf as Timeframe) : upstoxHistory(inst, tf as Timeframe, this.db.redis)).catch(
      (err) => (console.warn(`history ${key}:`, (err as Error).message), null),
    );
    if (bars?.length) {
      cache.set(key, { at: Date.now(), bars });
      this.store(symbol, tf, bars).catch(() => {}); // best effort: no DB means no archive, not no chart
      return bars;
    }
    return stored();
  }

  /** Recorded roll gaps for a symbol, newest last. Empty without a database. */
  @Get("rolls")
  async rolls(@Query("symbol") symbol: string): Promise<{ at: number; gap: number; from: string; to: string }[]> {
    if (!instrument(symbol)) throw new BadRequestException(`unknown symbol ${symbol}`);
    return this.rollRows(symbol).catch(() => []);
  }

  private async rollRows(symbol: string) {
    const rows = await this.db.sql`SELECT extract(epoch FROM at)::float8 AS at, gap, from_contract AS "from", to_contract AS "to" FROM rolls WHERE symbol = ${symbol} ORDER BY at`;
    return rows as { at: number; gap: number; from: string; to: string }[];
  }

  private async adjusted(symbol: string, bars: Bar[]): Promise<Bar[]> {
    const rolls: Roll[] = (await this.rollRows(symbol).catch(() => [])).map((r) => ({ at: r.at, gap: r.gap }));
    return adjustBackward(bars, rolls);
  }

  private async store(symbol: string, tf: string, bars: Bar[]) {
    const rows = bars.map((b) => ({ symbol, tf, time: new Date(b.time * 1000), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, oi: b.oi ?? null }));
    await this.db.sql`
      INSERT INTO candles ${this.db.sql(rows)}
      ON CONFLICT (symbol, tf, time) DO UPDATE
      SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume, oi = COALESCE(EXCLUDED.oi, candles.oi)`;
  }

  /** Stored provider candles, then our tick aggregate (bars_1m) rolled up in exchange time for anything newer. */
  private async fromDb(symbol: string, tf: Timeframe): Promise<Bar[]> {
    const tz = instrument(symbol)!.timeZone;
    const rows = (await this.db.sql`
      WITH stored AS (SELECT time, open, high, low, close, volume, oi FROM candles WHERE symbol = ${symbol} AND tf = ${tf}),
      live AS (
        SELECT time_bucket(${`${TIMEFRAMES[tf]} seconds`}::interval, bucket, ${tz}) AS time,
               first(open, bucket) AS open, max(high) AS high, min(low) AS low, last(close, bucket) AS close, sum(volume) AS volume, NULL::float8 AS oi
        FROM bars_1m
        WHERE symbol = ${symbol} AND bucket > coalesce((SELECT max(time) FROM stored), '-infinity')
        GROUP BY 1
      )
      SELECT extract(epoch FROM time)::float8 AS time, open, high, low, close, volume, oi
      FROM (SELECT * FROM stored UNION ALL SELECT * FROM live) all_bars
      ORDER BY time`) as (Bar & { oi: number | null })[];
    return rows.map(({ oi, ...bar }) => (oi === null ? bar : { ...bar, oi })); // a candle with no open interest simply has no `oi`, never null
  }
}
