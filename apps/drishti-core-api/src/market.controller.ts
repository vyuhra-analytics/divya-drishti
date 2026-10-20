import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { SYMBOLS, TIMEFRAMES, type Bar, type Timeframe } from "@drishti/shared";
import { Db } from "./db";

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

  /** OHLCV from the bars_1m continuous aggregate, rolled up to tf. from/to = epoch seconds. */
  @Get("bars")
  async bars(
    @Query("symbol") symbol: string,
    @Query("tf") tf: string = "1m",
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<Bar[]> {
    if (!symbol) throw new BadRequestException("symbol required");
    if (!(tf in TIMEFRAMES)) throw new BadRequestException(`tf must be one of ${Object.keys(TIMEFRAMES)}`);
    const seconds = TIMEFRAMES[tf as Timeframe];
    const toSec = to ? Number(to) : Date.now() / 1000;
    const fromSec = from ? Number(from) : toSec - seconds * 1000; // default: last 1000 bars
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) throw new BadRequestException("from/to must be epoch seconds");

    return this.db.sql`
      SELECT extract(epoch FROM time_bucket(${`${seconds} seconds`}::interval, bucket))::float8 AS time,
             first(open, bucket) AS open, max(high) AS high, min(low) AS low,
             last(close, bucket) AS close, sum(volume) AS volume
      FROM bars_1m
      WHERE symbol = ${symbol} AND bucket >= to_timestamp(${fromSec}) AND bucket < to_timestamp(${toSec})
      GROUP BY 1 ORDER BY 1`;
  }
}
