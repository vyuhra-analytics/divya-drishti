import { BadRequestException, Controller, Get, Query, ServiceUnavailableException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { shouldRecord, type Bar } from "@drishti/shared";
import { Db } from "./db";
import { loadContracts } from "./options.controller";
import { recordOptionCandles, type RecordSummary } from "./optionCandles.run";
import { OptionCandleStore, type OptionCandleStatus } from "./optionCandles.store";

const CHECK_EVERY_MS = 5 * 60_000;
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
const KEY = /^MCX_FO\|\d{3,8}$/;
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 40;
const MAX_ROWS = 25_000;

/**
 * Copies the one-minute candles (with open interest) of the option contracts we keep history for, once after each MCX session, while the
 * contracts live (Upstox serves them for live contracts only). OPTION_CANDLES=off disables the recorder. Read-only routes below.
 */
@Controller("option-candles")
export class OptionCandlesController implements OnModuleInit, OnModuleDestroy {
  private readonly store: OptionCandleStore;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private retryAt = 0;

  constructor(private readonly db: Db) {
    this.store = new OptionCandleStore(db.sql);
  }

  onModuleInit() {
    if (process.env.OPTION_CANDLES?.trim().toLowerCase() === "off") return;
    setTimeout(() => void this.tick(), 60_000);
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Record if a session has closed since the last recording; never two at once, and a failed run waits half an hour. */
  async tick(now = Date.now()): Promise<RecordSummary | null> {
    if (this.running || now < this.retryAt) return null;
    this.running = true; // taken before the first await: two ticks can never both get past this line
    try {
      const last = await this.store.lastRunAt().catch(() => undefined);
      if (!shouldRecord(last, now)) return null;
      return await this.record(last, now);
    } catch (err) {
      console.warn("option candle recording failed:", (err as Error).message);
      this.retryAt = now + RETRY_AFTER_FAILURE_MS;
      return null;
    } finally {
      this.running = false;
    }
  }

  private async record(lastRunAt: number | undefined, now: number): Promise<RecordSummary> {
    const token = (await this.db.redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim();
    if (!token) throw new Error("no Upstox token");
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    const summary = await recordOptionCandles({
      now,
      lastRunAt,
      contracts: loadContracts,
      get: async (url) => {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`Upstox ${res.status}`);
        return res.json();
      },
      store: this.store,
    });
    console.log(`option candles ${summary.window.from}..${summary.window.to}: ${summary.fetched}/${summary.contracts} contracts, ${summary.inserted} new of ${summary.candles} candles${summary.failed ? `, ${summary.failed} failed` : ""}${summary.dropped ? `, ${summary.dropped} refused` : ""}`);
    if (summary.fetched > 0 && summary.failed <= summary.contracts * 0.2) await this.store.setLastRun(now);
    else this.retryAt = now + RETRY_AFTER_FAILURE_MS;
    return summary;
  }

  /** How much is stored and when it last ran. GET /option-candles/status */
  @Get("status")
  async status(): Promise<OptionCandleStatus> {
    return this.store.status().catch(() => {
      throw new ServiceUnavailableException("the database is not available");
    });
  }

  /** One contract's stored candles, oldest first (at most 25,000). GET /option-candles?key=MCX_FO|582939&from=2026-10-20&to=2026-10-22 (IST dates) */
  @Get()
  async candles(@Query("key") key?: string, @Query("from") from?: string, @Query("to") to?: string): Promise<Bar[]> {
    if (!key || !KEY.test(key)) throw new BadRequestException("key must look like MCX_FO|582939");
    if (!from || !to || !DAY_FORMAT.test(from) || !DAY_FORMAT.test(to)) throw new BadRequestException("from and to must be YYYY-MM-DD (IST dates)");
    const start = Date.parse(`${from}T00:00:00+05:30`) / 1000;
    const end = Date.parse(`${to}T23:59:59+05:30`) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new BadRequestException("to must not be before from");
    if ((end - start) / 86_400 > MAX_DAYS) throw new BadRequestException(`at most ${MAX_DAYS} days at a time`);
    return this.store.candles(key, start, end, MAX_ROWS).catch(() => {
      throw new ServiceUnavailableException("the database is not available");
    });
  }
}
