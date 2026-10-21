import { userAgentFor } from "@drishti/shared";
import { BadRequestException, Controller, Get, HttpException, Query, ServiceUnavailableException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  applyOiBaseline,
  atmStrike,
  buildRows,
  buildTvChain,
  chunk,
  expiriesOf,
  expiryDate,
  LruCache,
  mapLimit,
  maxPain,
  mcxSession,
  mergeChains,
  parseTvOptions,
  pcr,
  pickStrikes,
  TV_OPTION_COLUMNS,
  tvUnderlyings,
  type Chain,
  type OptionContract,
  type UpstoxGreeks,
  type UpstoxQuote,
} from "@drishti/shared";
import { Db } from "./db";
import { OiStore } from "./oi.store";

const UNDERLYINGS = ["CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI"];
const SOURCES = ["auto", "combined", "upstox", "tradingview"] as const;
type Source = (typeof SOURCES)[number];
const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz";
const TV_OPTIONS_URL = "https://scanner.tradingview.com/options/scan2?label-product=symbols-options";
const TV_QUOTE_URL = "https://scanner.tradingview.com/global/scan";
const TV_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
  "User-Agent": userAgentFor("scanner.tradingview.com"),
};
const STRIKES_EACH_SIDE = 12; // the compact panel; the detailed one asks for more with ?strikes=
const MAX_STRIKES_EACH_SIDE = 40;
const GREEKS_PER_CALL = 50; // Upstox's limit per option-greek call: a wider chain is fetched in batches of this size
const CHAIN_TTL_MS = 3000;
const TV_CHAIN_TTL_MS = 1000; // TradingView's options are streaming: refresh the shared copy every second
const TV_EXPIRIES_TTL_MS = 5 * 60_000;
const MASTER_TTL_MS = 6 * 3600_000;
const EXPIRY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

let master: { at: number; contracts: OptionContract[] } | null = null;
// Keys are built from caller input, so every cache is capped (4 underlyings × 3 feeds × a few expiries is the real working set).
const chains = new LruCache<{ at: number; chain: Chain }>(64);
// each feed is cached on its own clock so a combined chain refreshes TradingView every second but asks Upstox every 3 s
const feedCache = new LruCache<{ at: number; chain: Chain }>(64);
const tvExpiries = new LruCache<{ at: number; list: { expiry: number; ticker: string }[] }>(16);

async function loadContracts(): Promise<OptionContract[]> {
  if (master && Date.now() - master.at < MASTER_TTL_MS) return master.contracts;
  const res = await fetch(MASTER_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`instrument master ${res.status}`);
  const rows: any[] = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()))));
  const contracts = rows.filter((r) => (r.instrument_type === "CE" || r.instrument_type === "PE") && UNDERLYINGS.includes(r.underlying_symbol)) as OptionContract[];
  master = { at: Date.now(), contracts };
  return contracts;
}

/** Upstox keyed responses use "EXCHANGE:SYMBOL" keys; every entry also carries instrument_token ("MCX_FO|123"). */
const byToken = <T>(data: Record<string, any> | undefined) => new Map(Object.values(data ?? {}).map((v: any) => [v.instrument_token as string, v as T]));

const tvPost = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: "POST", headers: TV_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ServiceUnavailableException(`TradingView ${res.status}`);
  return (await res.json()) as any;
};
const tvOptionQuery = (ticker: string, columns: readonly string[], extra: object[] = [], range = 2000) => ({
  columns,
  filter: [{ left: "type", operation: "equal", right: "option" }, ...extra],
  ignore_unknown_fields: true,
  index_filters: [{ name: "underlying_symbol", values: [ticker] }],
  range: [0, range],
});

/**
 * Live MCX options chain, from Upstox (contracts from the public instrument master, quotes with open interest, greeks)
 * or from TradingView's public options scanner (live bid/ask, theoretical price, IV and greeks, no open interest or volume).
 * `source=auto` (default) and `combined` merge both: TradingView's live prices, IV and greeks with Upstox's last trade, open interest
 * and volume per strike; whichever feed is missing is left out (Upstox down: TradingView alone; an expiry TradingView does not list: Upstox alone).
 * Cached 3 s (1 s for TradingView) so several open panels share a fetch.
 * GET /options?underlying=CRUDEOIL&expiry=2026-11-17&source=auto (expiry optional: nearest)
 */
@Controller("options")
export class OptionsController implements OnModuleInit, OnModuleDestroy {
  private readonly oi: OiStore;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly db: Db) {
    this.oi = new OiStore(db.sql);
  }

  /**
   * Keep the open-interest snapshots coming while MCX is open even with no panel open: every 10 minutes read the wide chain of the
   * first two expiries of crude and natural gas (which stores the readings), so the next session has a baseline for "OI change".
   * CANARIES-style opt-out: OI_RECORDER=off.
   */
  onModuleInit() {
    if (process.env.OI_RECORDER?.trim().toLowerCase() === "off") return;
    const run = async () => {
      if (!mcxSession(Date.now()).open) return;
      for (const underlying of ["CRUDEOIL", "NATURALGAS"]) {
        const first = await this.chain(underlying, undefined, "upstox", String(MAX_STRIKES_EACH_SIDE)).catch(() => null);
        const second = first?.expiries[1];
        if (second) await this.chain(underlying, second, "upstox", String(MAX_STRIKES_EACH_SIDE)).catch(() => null);
      }
    };
    setTimeout(() => void run(), 30_000);
    this.timer = setInterval(() => void run(), 10 * 60_000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  @Get()
  async chain(@Query("underlying") underlying = "CRUDEOIL", @Query("expiry") expiryParam?: string, @Query("source") sourceParam: string = "auto", @Query("strikes") strikesParam?: string): Promise<Chain> {
    if (!UNDERLYINGS.includes(underlying)) throw new BadRequestException(`underlying must be one of ${UNDERLYINGS}`);
    if (!(SOURCES as readonly string[]).includes(sourceParam)) throw new BadRequestException(`source must be one of ${SOURCES}`);
    if (expiryParam !== undefined && !EXPIRY_FORMAT.test(expiryParam)) throw new BadRequestException("expiry must be YYYY-MM-DD");
    const each = strikesParam === undefined ? STRIKES_EACH_SIDE : Number(strikesParam);
    if (!Number.isInteger(each) || each < 4 || each > MAX_STRIKES_EACH_SIDE) throw new BadRequestException(`strikes must be a whole number from 4 to ${MAX_STRIKES_EACH_SIDE}`);
    const source = sourceParam as Source;

    const key = `${source}|${underlying}|${expiryParam ?? ""}|${each}`;
    const hit = chains.get(key);
    if (hit && Date.now() - hit.at < (hit.chain.source === "upstox" ? CHAIN_TTL_MS : TV_CHAIN_TTL_MS)) return hit.chain;

    let chain: Chain;
    if (source === "tradingview") chain = await this.feed("tv", underlying, expiryParam, each);
    else if (source === "upstox") chain = await this.feed("upstox", underlying, expiryParam, each);
    else chain = await this.combined(underlying, expiryParam, each);
    chain = await this.withOi(chain);
    chains.set(key, { at: Date.now(), chain });
    return chain;
  }

  /** Add OI change from our own snapshots, and store this reading for tomorrow's baseline. */
  private async withOi(chain: Chain): Promise<Chain> {
    const base = await this.oi.baseline(chain);
    void this.oi.record(chain);
    return applyOiBaseline(chain, base);
  }

  /** One feed's chain, cached on that feed's own clock (TradingView 1 s, Upstox 3 s). */
  private async feed(which: "tv" | "upstox", underlying: string, expiryParam: string | undefined, each: number): Promise<Chain> {
    const key = `${which}|${underlying}|${expiryParam ?? ""}|${each}`;
    const hit = feedCache.get(key);
    if (hit && Date.now() - hit.at < (which === "tv" ? TV_CHAIN_TTL_MS : CHAIN_TTL_MS)) return hit.chain;
    const chain = which === "tv" ? await this.tradingViewChain(underlying, expiryParam, each) : await this.upstoxChain(underlying, expiryParam, each);
    feedCache.set(key, { at: Date.now(), chain });
    return chain;
  }

  /**
   * TradingView's live prices and greeks with Upstox's last trade, open interest and volume. When only one feed answers, that
   * one is returned (`auto` and `combined` are the same).
   */
  private async combined(underlying: string, expiryParam: string | undefined, each: number): Promise<Chain> {
    const [tv, up] = await Promise.allSettled([this.feed("tv", underlying, expiryParam, each), this.feed("upstox", underlying, expiryParam, each)]);
    if (tv.status === "fulfilled" && up.status === "fulfilled" && tv.value.expiry === up.value.expiry) return mergeChains(tv.value, up.value);
    if (up.status === "fulfilled" && (tv.status === "rejected" || tv.value.expiry !== up.value.expiry)) return up.value; // TradingView does not list this expiry
    if (tv.status === "fulfilled") return tv.value; // Upstox not connected or down
    throw (up as PromiseRejectedResult).reason;
  }

  private async tradingViewChain(underlying: string, expiryParam: string | undefined, each: number): Promise<Chain> {
    // each option expiry sits on its own future: ask the next few dated futures which expiries they carry
    let known = tvExpiries.get(underlying);
    if (!known || Date.now() - known.at > TV_EXPIRIES_TTL_MS) {
      const found = await Promise.all(
        tvUnderlyings(underlying, "MCX", Date.now()).map(async ({ ticker }) => {
          const json = await tvPost(TV_OPTIONS_URL, tvOptionQuery(ticker, ["expiration"])).catch(() => null);
          const days = new Set<number>((json?.symbols ?? []).map((r: any) => r.f?.[0]).filter((n: unknown) => typeof n === "number"));
          return [...days].map((n) => ({ expiry: Date.UTC(Math.floor(n / 10000), Math.floor((n % 10000) / 100) - 1, n % 100), ticker }));
        }),
      );
      known = { at: Date.now(), list: found.flat().sort((a, b) => a.expiry - b.expiry) };
      tvExpiries.set(underlying, known);
    }
    if (known.list.length === 0) throw new ServiceUnavailableException("TradingView lists no options for this underlying right now");
    const expiries = known.list.map((e) => expiryDate(e.expiry));
    const pick = (expiryParam && known.list.find((e) => expiryDate(e.expiry) === expiryParam)) || known.list[0];

    const [optionsJson, quoteJson] = await Promise.all([
      tvPost(TV_OPTIONS_URL, tvOptionQuery(pick.ticker, TV_OPTION_COLUMNS, [{ left: "expiration", operation: "equal", right: Number(expiryDate(pick.expiry).replaceAll("-", "")) }])),
      tvPost(TV_QUOTE_URL, { symbols: { tickers: [pick.ticker] }, columns: ["close"] }).catch(() => null),
    ]);
    const spot = quoteJson?.data?.[0]?.d?.[0];
    return buildTvChain(parseTvOptions(optionsJson), {
      underlying,
      expiries,
      expiry: pick.expiry,
      spot: typeof spot === "number" ? spot : undefined,
      each,
      now: Date.now(),
    });
  }

  private async upstoxChain(underlying: string, expiryParam: string | undefined, each: number): Promise<Chain> {
    const token = (await this.db.redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim();
    if (!token) throw new ServiceUnavailableException("Upstox not connected: set UPSTOX_ACCESS_TOKEN or log in from Settings → Data feeds");
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    const get = async (url: string) => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new ServiceUnavailableException(`Upstox ${res.status}`);
      return (await res.json()) as any;
    };

    const contracts = await loadContracts();
    const expiries = expiriesOf(contracts, underlying, Date.now());
    const expiry = expiryParam && expiries.includes(expiryParam) ? expiryParam : expiries[0];
    if (!expiry) throw new ServiceUnavailableException("No option expiries found");
    const ofExpiry = contracts.filter((c) => c.underlying_symbol === underlying && expiryDate(c.expiry) === expiry);

    // spot = the future these options settle against
    const futureKey = ofExpiry[0].underlying_key;
    const spotQuote = byToken<UpstoxQuote>((await get(`https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(futureKey)}`)).data);
    const spot = spotQuote.get(futureKey)?.last_price;

    const strikes = pickStrikes(ofExpiry.map((c) => c.strike_price), spot ?? ofExpiry[Math.floor(ofExpiry.length / 2)].strike_price, each);
    const wanted = ofExpiry.filter((c) => strikes.includes(c.strike_price));
    const allKeys = wanted.map((c) => c.instrument_key);
    const enc = (ks: string[]) => encodeURIComponent(ks.join(","));
    // quotes take many keys at once; greeks take 50 per call, so a wide chain is several calls (3 at a time)
    const [q, greekParts] = await Promise.all([
      get(`https://api.upstox.com/v2/market-quote/quotes?instrument_key=${enc(allKeys)}`),
      mapLimit(chunk(allKeys, GREEKS_PER_CALL), 3, (ks) => get(`https://api.upstox.com/v3/market-quote/option-greek?instrument_key=${enc(ks)}`).catch(() => ({ data: {} }))), // greeks optional
    ]);
    const greeks = new Map<string, UpstoxGreeks>();
    for (const part of greekParts) for (const [k, v] of byToken<UpstoxGreeks>(part.data)) greeks.set(k, v);
    const rows = buildRows(wanted, byToken<UpstoxQuote>(q.data), greeks);

    return {
      underlying,
      expiry,
      expiries,
      spot,
      atm: spot === undefined ? undefined : atmStrike(strikes, spot),
      lot: wanted[0]?.lot_size,
      // ponytail: PCR / max pain use the ±12 strikes shown, not the whole chain; fetch all strikes' OI if exact figures matter
      pcr: pcr(rows),
      maxPain: maxPain(rows),
      rows,
      updatedAt: Date.now(),
      source: "upstox",
      delayedBy: 0,
    };
  }
}
