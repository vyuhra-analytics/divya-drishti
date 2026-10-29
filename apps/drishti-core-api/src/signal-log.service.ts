import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { analyzeReport, evaluateReportDay, evaluateUsib, instrument, nyDay, recentUsOpens, REPORT_DAY, reportKey, skippedRecord, usibKey, windowClosed, type Bar, type ReportCode, type SignalRecord } from "@drishti/shared";
import { Db } from "./db";
import { EiaReportService } from "./eia-report.service";
import { ForecastService } from "./forecast.service";
import { upstoxHistory } from "./history";
import { PgSignalStore } from "./signal-log.store";

const TICK_MS = 60_000;
const LOOKBACK_DAYS = 3;
const USIB_SYMBOLS = ["MCX:CRUDEOIL", "MCX:NATGASMINI"] as const;

/**
 * The signal log: after the entry window of each report day and each USIB evening has closed, the same pure rules the screens use are run on the closed 5-minute
 * candles and the outcome is stored once, whether or not anybody traded it or had the app open. Report days come from the stored reports (their official release
 * time); USIB runs on every US session in the last three days, and is logged as skipped on a day an EIA report was out. `SIGNAL_LOG=off` disables it.
 */
@Injectable()
export class SignalLogService implements OnModuleInit, OnModuleDestroy {
  readonly store: PgSignalStore;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** replaceable for tests: 5-minute candles of a market, oldest first */
  bars: (symbol: string) => Promise<Bar[]>;

  constructor(
    private readonly db: Db,
    private readonly reports: EiaReportService,
    private readonly forecasts?: ForecastService,
  ) {
    this.store = new PgSignalStore(db.sql);
    this.bars = async (symbol) => {
      const inst = instrument(symbol);
      return inst ? ((await upstoxHistory(inst, "5m", this.db.redis)) ?? []) : [];
    };
  }

  onModuleInit() {
    if (process.env.SIGNAL_LOG?.trim().toLowerCase() === "off") return;
    this.timer = setTimeout(() => void this.loop(), 45_000);
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      await this.tick();
    } catch (e) {
      console.warn(`signal log: ${(e as Error).message}`);
    }
    this.timer = setTimeout(() => void this.loop(), TICK_MS);
  }

  /** One pass: log every evening in the last few days whose window has closed and that is not logged yet. Returns the keys stored. */
  async tick(now = Date.now()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const stored: string[] = [];
      const byMarket = new Map<string, Promise<Bar[]>>();
      const barsOf = (symbol: string) => (byMarket.get(symbol) ?? byMarket.set(symbol, this.bars(symbol).catch(() => [])).get(symbol)!);
      const reportDays = new Set<string>(); // New York dates on which an EIA report was out
      for (const code of ["WPSR", "WNGSR"] as ReportCode[]) {
        for (const w of await this.reports.store.weeks(code, 4)) {
          const releaseAt = w.officialReleaseAt;
          if (releaseAt === undefined || now - releaseAt > LOOKBACK_DAYS * 86_400_000 || releaseAt > now) continue;
          reportDays.add(nyDay(releaseAt));
          if (!windowClosed("report-day", releaseAt, now) || (await this.store.has(reportKey(code, releaseAt)))) continue;
          const record = await this.reportDay(code, w.weekEnding, releaseAt, barsOf);
          if (record && (await this.store.add(record))) stored.push(record.key);
        }
      }
      for (const openAt of recentUsOpens(now, LOOKBACK_DAYS)) {
        if (!windowClosed("usib", openAt, now)) continue;
        for (const symbol of USIB_SYMBOLS) {
          if (await this.store.has(usibKey(symbol, openAt))) continue;
          const record = reportDays.has(nyDay(openAt))
            ? skippedRecord("usib", usibKey(symbol, openAt), symbol, openAt, "an EIA report was out that day: the report-day strategy runs instead")
            : evaluateUsib({ symbol, openAt, bars: await barsOf(symbol) });
          // no candles at all is a holiday or a feed outage, not a strategy outcome worth a permanent row: leave it to be tried again within the lookback
          if (record.status === "no_bars" && now - openAt < LOOKBACK_DAYS * 86_400_000 - 3600_000) continue;
          if (await this.store.add(record)) stored.push(record.key);
        }
      }
      return stored;
    } finally {
      this.running = false;
    }
  }

  private async reportDay(code: ReportCode, week: string, releaseAt: number, barsOf: (s: string) => Promise<Bar[]>): Promise<SignalRecord | undefined> {
    const found = await this.reports.store.latest(code, week);
    if (!found) return undefined;
    // the forecast as the screen ranks it: recorded for the release, else the Investing.com consensus
    let forecast = (await this.reports.store.forecastFor(found.eventId))?.value;
    let source = forecast === undefined ? undefined : "recorded";
    if (forecast === undefined) {
      const c = code === "WPSR" ? await this.forecasts?.crudeFor(releaseAt).catch(() => undefined) : await this.forecasts?.around("eia_gas", releaseAt).then((r) => (r?.forecast === undefined ? undefined : { value: r.forecast, source: "Investing.com consensus" })).catch(() => undefined);
      forecast = c?.value;
      source = c?.source;
    }
    const a = analyzeReport({ report: code, periodEnd: Date.parse(found.weekEnding), releasedAt: found.officialReleaseAt, rows: found.rows }, { forecast });
    if (!a) return undefined; // a stored report we cannot read: tried again next pass
    const bars = await barsOf(REPORT_DAY[code].symbol);
    return evaluateReportDay({ code, releaseAt, bars, change: a.headline.change, forecast: a.headline.forecast, forecastSource: source, surprise: a.headline.surprise, side: a.headline.side });
  }
}
