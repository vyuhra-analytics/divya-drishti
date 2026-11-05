import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { buildNotifyConfig, completedBars, computeDrivers, deliver, DRIVER_PAIRS, evaluateSetup, FX_SYMBOL, instrument, mcxSession, premiumSeries, premiumStats, setupKey, setupMessage, setupRecord, tradingExpiry, type Bar, type CalEvent, type Chain, type DayOverride, type Quote, type SetupResult, type SignalRecord } from "@drishti/shared";
import { liveSources, type Sources } from "./briefing-facts";
import { Db } from "./db";
import { PgSignalStore } from "./signal-log.store";

const TICK_MS = 60_000;
const QUOTE_MAX_AGE_MS = 120_000;
const TF = { "1d": 86_400, "1h": 3_600, "15m": 900 } as const;
const io = { fetch: (input: string | URL, init?: RequestInit) => fetch(input, init), env: process.env, now: Date.now };

/** Markets the scanner watches: `TREND_SETUP_SYMBOLS` (comma separated MCX symbols), default crude and gas mini as for USIB. */
export const scanSymbols = (env = process.env) =>
  (env.TREND_SETUP_SYMBOLS?.trim() || "MCX:CRUDEOIL,MCX:NATGASMINI")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => instrument(s)?.exchange === "MCX");

export interface ScanOutcome {
  symbol: string;
  result?: SetupResult;
  underlying?: string;
  expiry?: string;
  /** why the checklist could not be run (no live price, no bars) */
  skipped?: string;
}

/**
 * The same checklist the Trend setup panel runs, gathered on the server from this API's own routes: completed daily, 60- and 15-minute bars, the live quote,
 * NYMEX and USD/INR for the confirmation and the premium's rank, the high-impact releases of the next three days, and the option chain on the trading expiry.
 */
export async function scanSetup(symbol: string, s: Sources, override?: DayOverride | null): Promise<ScanOutcome> {
  const inst = instrument(symbol);
  if (!inst || inst.exchange !== "MCX") return { symbol, skipped: "not an MCX future" };
  const now = s.now();
  const global = DRIVER_PAIRS[symbol];
  const bars = (sym: string | undefined, tf: string) => (sym ? s.api<Bar[]>(`/bars?symbol=${encodeURIComponent(sym)}&tf=${tf}`).then((b) => (Array.isArray(b) ? b : [])) : Promise.resolve([] as Bar[]));
  const quote = (sym: string | undefined) => (sym ? s.api<Quote>(`/quotes/${encodeURIComponent(sym)}`) : Promise.resolve(undefined));
  const underlying = inst.upstox === "CRUDEOILM" ? "CRUDEOIL" : inst.upstox; // crude mini has no options of its own
  const [daily, hourly, m15, m5, g5, f5, q, gq, fq, events, first] = await Promise.all([
    bars(symbol, "1d"),
    bars(symbol, "1h"),
    bars(symbol, "15m"),
    bars(symbol, "5m"),
    bars(global, "5m"),
    bars(FX_SYMBOL, "5m"),
    quote(symbol),
    quote(global),
    quote(FX_SYMBOL),
    s.api<CalEvent[]>("/calendar?days=3"),
    underlying ? s.api<Chain>(`/options?underlying=${underlying}`) : Promise.resolve(undefined),
  ]);
  if (!q || now - q.time > QUOTE_MAX_AGE_MS) return { symbol, skipped: "no live price in the last 2 minutes" };
  if (!m15.length || !hourly.length || !daily.length) return { symbol, skipped: "bars unavailable" };
  let chain = first;
  const want = chain?.expiries ? tradingExpiry(chain.expiries, now) : undefined;
  if (want && chain && want !== chain.expiry) chain = (await s.api<Chain>(`/options?underlying=${underlying}&expiry=${want}`)) ?? chain;

  const d = computeDrivers(q, gq, fq);
  const stats = d.premiumPct === undefined ? undefined : premiumStats(premiumSeries(m5, g5, f5), d.premiumPct);
  const topic = inst.topic === "natgas" ? "gas" : "crude";
  const evs = (Array.isArray(events) ? events : []).filter((e) => e.kind !== "holiday" && e.impact === "high" && (e.relevance ?? []).includes(topic)).map((e) => ({ title: e.title, at: e.at }));
  const session = mcxSession(now, override ?? undefined);
  const nowSec = now / 1000;
  const result = evaluateSetup({
    daily: completedBars(daily, TF["1d"], nowSec),
    hourly: completedBars(hourly, TF["1h"], nowSec),
    m15: completedBars(m15, TF["15m"], nowSec),
    price: q.price,
    confirm: { nymexPct: d.split?.global, fxPct: d.split?.fx, premiumRank: stats?.rank },
    events: evs,
    chain: underlying ? chain : undefined,
    now,
    minutesToClose: session.open && session.next ? (session.next - now) / 60_000 : undefined,
  });
  return { symbol, result, underlying, expiry: chain?.expiry };
}

/**
 * The trend setup scanner: every minute while MCX is open it runs the checklist for each watched market and, the first time in an India day that it turns
 * READY, stores the plan in the signal log (strategy `trend-setup`, one a day as the setup allows) and sends it to Telegram / the webhook. Runs with the
 * browser closed. Places no order. `TREND_SETUP_SCAN=off` disables it.
 */
@Injectable()
export class TrendSetupService implements OnModuleInit, OnModuleDestroy {
  readonly store: PgSignalStore;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** replaceable for tests */
  sources: Sources = liveSources;
  scan: typeof scanSetup = scanSetup;
  notify: (rec: SignalRecord, text: string) => Promise<unknown>;
  /** the latest outcome per market, for GET /signals/trend-setup/status */
  readonly last = new Map<string, { at: number; verdict?: string; summary?: string; skipped?: string }>();

  constructor(private readonly db: Db) {
    this.store = new PgSignalStore(db.sql);
    this.notify = async (rec, text) => {
      const cfg = await buildNotifyConfig(process.env, async () => ((await this.db.sql`SELECT value FROM kv WHERE key = 'telegram_chat_id'`) as { value: string }[])[0]?.value);
      return deliver({ id: rec.key, rule: "trend setup", message: text, at: rec.at }, cfg, io);
    };
  }

  onModuleInit() {
    if (process.env.TREND_SETUP_SCAN?.trim().toLowerCase() === "off") return;
    this.timer = setTimeout(() => void this.loop(), 60_000);
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      await this.tick();
    } catch (e) {
      console.warn(`trend setup scan: ${(e as Error).message}`);
    }
    this.timer = setTimeout(() => void this.loop(), TICK_MS);
  }

  /** One pass over the watched markets. Returns the keys of the signals stored. */
  async tick(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const now = this.sources.now();
      const override = (await this.sources.api<{ mcx: DayOverride | null }>("/market/sessions"))?.mcx;
      if (!mcxSession(now, override ?? undefined).open) return [];
      const stored: string[] = [];
      for (const symbol of scanSymbols()) {
        if (await this.store.has(setupKey(symbol, now))) continue; // one a day
        const o = await this.scan(symbol, this.sources, override);
        this.last.set(symbol, { at: now, verdict: o.result?.verdict, summary: o.result?.summary, skipped: o.skipped });
        if (o.result?.verdict !== "ready") continue;
        const rec = setupRecord(symbol, o.result, now, o.underlying, o.expiry);
        if (!(await this.store.add(rec))) continue;
        stored.push(rec.key);
        console.log(`trend setup: READY on ${symbol}, stored ${rec.key}`);
        await this.notify(rec, setupMessage(rec, instrument(symbol)?.decimals ?? 1)).catch((e) => console.warn(`trend setup: alert not delivered: ${(e as Error).message}`));
      }
      return stored;
    } finally {
      this.running = false;
    }
  }
}
