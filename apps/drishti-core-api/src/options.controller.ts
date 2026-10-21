import { BadRequestException, Controller, Get, HttpException, Query, ServiceUnavailableException } from "@nestjs/common";
import {
  atmStrike,
  buildRows,
  buildTvChain,
  expiriesOf,
  expiryDate,
  LruCache,
  maxPain,
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

const UNDERLYINGS = ["CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI"];
const SOURCES = ["auto", "upstox", "tradingview"] as const;
type Source = (typeof SOURCES)[number];
const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz";
const TV_OPTIONS_URL = "https://scanner.tradingview.com/options/scan2?label-product=symbols-options";
const TV_QUOTE_URL = "https://scanner.tradingview.com/global/scan";
const TV_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36",
};
const STRIKES_EACH_SIDE = 12; // 25 strikes → 50 option keys = Upstox's greeks limit per call
const CHAIN_TTL_MS = 3000;
const TV_CHAIN_TTL_MS = 1000; // TradingView's options are streaming: refresh the shared copy every second
const TV_EXPIRIES_TTL_MS = 5 * 60_000;
const MASTER_TTL_MS = 6 * 3600_000;
const EXPIRY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

let master: { at: number; contracts: OptionContract[] } | null = null;
// Keys are built from caller input, so every cache is capped (4 underlyings × 3 feeds × a few expiries is the real working set).
const chains = new LruCache<{ at: number; chain: Chain }>(64);
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
 * `source=auto` (default) tries Upstox and falls back to TradingView when Upstox is not connected or fails.
 * Cached 3 s (1 s for TradingView) so several open panels share a fetch.
 * GET /options?underlying=CRUDEOIL&expiry=2026-11-17&source=auto (expiry optional: nearest)
 */
@Controller("options")
export class OptionsController {
  constructor(private readonly db: Db) {}

  @Get()
  async chain(@Query("underlying") underlying = "CRUDEOIL", @Query("expiry") expiryParam?: string, @Query("source") sourceParam: string = "auto"): Promise<Chain> {
    if (!UNDERLYINGS.includes(underlying)) throw new BadRequestException(`underlying must be one of ${UNDERLYINGS}`);
    if (!(SOURCES as readonly string[]).includes(sourceParam)) throw new BadRequestException(`source must be one of ${SOURCES}`);
    if (expiryParam !== undefined && !EXPIRY_FORMAT.test(expiryParam)) throw new BadRequestException("expiry must be YYYY-MM-DD");
    const source = sourceParam as Source;

    const key = `${source}|${underlying}|${expiryParam ?? ""}`;
    const hit = chains.get(key);
    if (hit && Date.now() - hit.at < (hit.chain.source === "tradingview" ? TV_CHAIN_TTL_MS : CHAIN_TTL_MS)) return hit.chain;

    let chain: Chain;
    if (source === "tradingview") chain = await this.tradingViewChain(underlying, expiryParam);
    else if (source === "upstox") chain = await this.upstoxChain(underlying, expiryParam);
    else {
      try {
        chain = await this.upstoxChain(underlying, expiryParam);
      } catch (e) {
        if (!(e instanceof HttpException)) throw e;
        chain = await this.tradingViewChain(underlying, expiryParam); // Upstox not connected or down: the TradingView feed still has bid/ask, IV and greeks
      }
    }
    chains.set(key, { at: Date.now(), chain });
    return chain;
  }

  private async tradingViewChain(underlying: string, expiryParam?: string): Promise<Chain> {
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
      each: STRIKES_EACH_SIDE,
      now: Date.now(),
    });
  }

  private async upstoxChain(underlying: string, expiryParam?: string): Promise<Chain> {
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

    const strikes = pickStrikes(ofExpiry.map((c) => c.strike_price), spot ?? ofExpiry[Math.floor(ofExpiry.length / 2)].strike_price, STRIKES_EACH_SIDE);
    const wanted = ofExpiry.filter((c) => strikes.includes(c.strike_price));
    const keys = encodeURIComponent(wanted.map((c) => c.instrument_key).join(","));
    const [q, g] = await Promise.all([
      get(`https://api.upstox.com/v2/market-quote/quotes?instrument_key=${keys}`),
      get(`https://api.upstox.com/v3/market-quote/option-greek?instrument_key=${keys}`).catch(() => ({ data: {} })), // greeks optional
    ]);
    const rows = buildRows(wanted, byToken<UpstoxQuote>(q.data), byToken<UpstoxGreeks>(g.data));

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
