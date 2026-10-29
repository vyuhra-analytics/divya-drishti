import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { analyzeReport, evaluateReportDay, evaluateUsib, instrument, nyDay, optionLegFor, type Chain, recentUsOpens, REPORT_DAY, reportKey, skippedRecord, usibKey, windowClosed, type Bar, type ReportCode, type SignalRecord } from "@drishti/shared";
import { Db } from "./db";
import { EiaReportService } from "./eia-report.service";
import { ForecastService } from "./forecast.service";
import { upstoxHistory } from "./history";
import { recordedChainAt } from "./recorded-chain";
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
          if (record && (await this.store.add(await this.withOption(record)))) stored.push(record.key);
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
          if (await this.store.add(await this.withOption(record))) stored.push(record.key);
        }
      }
      return stored;
    } finally {
      this.running = false;
    }
  }

  /**
   * The option to buy for a logged signal: the chain as recorded at the moment the signal candle closed (crude on the nearest expiry, gas on the next, as on the
   * screens), the strike the screen's own rule picks, and its premium levels from the future's R through the delta. The premium is the contract's ask from the
   * live-feed recording within two minutes before the signal when there is one, else the snapshot's (up to 15 minutes old, said in `basis`). Never guessed: with
   * no snapshot the record says so.
   */
  async withOption(rec: SignalRecord): Promise<SignalRecord> {
    const s = rec.signal;
    if (rec.status !== "signal" || !s) return rec;
    const underlying = rec.symbol.replace(/^MCX:/, "");
    const at = s.closedAt * 1000;
    try {
      const sql = this.db.sql;
      let r = await recordedChainAt(sql, underlying, undefined, at, 12);
      if ("miss" in r) return { ...rec, optionNote: r.miss === "no-snapshot" ? "no option chain snapshot was recorded by then" : "the snapshot holds no options" };
      if (underlying === "NATGASMINI" && r.chain.expiries[1] && r.chain.expiry !== r.chain.expiries[1]) {
        const next = await recordedChainAt(sql, underlying, r.chain.expiries[1], at, 12);
        if ("chain" in next) r = next;
      }
      let chain: Chain = r.chain;
      let basis = `snapshot ${Math.round((at - chain.updatedAt) / 60_000)} min before the signal`;
      const first = optionLegFor(s, chain, underlying);
      const key = first.leg?.key;
      if (first.leg && key) {
        const q = (await sql`
          SELECT price, ask, delta, extract(epoch FROM time)::float8 * 1000 AS t FROM feed_quotes
          WHERE key = ${key} AND time <= ${new Date(at).toISOString()} AND time >= ${new Date(at - 120_000).toISOString()} ORDER BY time DESC LIMIT 1`.catch(() => [])) as { price: number | null; ask: number | null; delta: number | null; t: number }[];
        const ask = q[0]?.ask && q[0].ask > 0 ? Number(q[0].ask) : undefined;
        if (ask) {
          const delta = q[0].delta ? Math.abs(Number(q[0].delta)) : first.leg.delta;
          chain = { ...chain, rows: chain.rows.map((row) => (row.strike === first.leg!.strike ? { ...row, [first.leg!.type === "CE" ? "ce" : "pe"]: { ...(first.leg!.type === "CE" ? row.ce : row.pe), ask, ltp: ask, delta: first.leg!.type === "CE" ? delta : -delta } } : row)) };
          basis = `live-feed ask ${Math.round((at - Number(q[0].t)) / 1000)} s before the signal`;
        }
      }
      const { leg, reason } = optionLegFor(s, chain, underlying); // again, now with the ask of the moment when the feed recording had one
      return leg ? { ...rec, option: { ...leg, basis } } : { ...rec, optionNote: reason };
    } catch (e) {
      return { ...rec, optionNote: `the option leg could not be worked out: ${(e as Error).message}` };
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
