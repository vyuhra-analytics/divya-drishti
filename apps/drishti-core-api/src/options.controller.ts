import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import {
  atmStrike,
  buildRows,
  expiriesOf,
  expiryDate,
  maxPain,
  pcr,
  pickStrikes,
  type Chain,
  type OptionContract,
  type UpstoxGreeks,
  type UpstoxQuote,
} from "@drishti/shared";
import { Db } from "./db";

const UNDERLYINGS = ["CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI"];
const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz";
const STRIKES_EACH_SIDE = 12; // 25 strikes → 50 option keys = Upstox's greeks limit per call
const CHAIN_TTL_MS = 3000;
const MASTER_TTL_MS = 6 * 3600_000;

let master: { at: number; contracts: OptionContract[] } | null = null;
const chains = new Map<string, { at: number; chain: Chain }>();

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

/**
 * Live MCX options chain from Upstox: contracts from the public instrument master, ±12 strikes around ATM,
 * quotes (LTP, depth, OI, volume) and greeks (IV, delta, theta, vega). Cached 3 s so several open panels share a fetch.
 * GET /options?underlying=CRUDEOIL&expiry=2026-11-17 (expiry optional: nearest)
 */
@Controller("options")
export class OptionsController {
  constructor(private readonly db: Db) {}

  @Get()
  async chain(@Query("underlying") underlying = "CRUDEOIL", @Query("expiry") expiryParam?: string): Promise<Chain> {
    if (!UNDERLYINGS.includes(underlying)) throw new BadRequestException(`underlying must be one of ${UNDERLYINGS}`);
    const key = `${underlying}|${expiryParam ?? ""}`;
    const hit = chains.get(key);
    if (hit && Date.now() - hit.at < CHAIN_TTL_MS) return hit.chain;

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

    const chain: Chain = {
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
    };
    chains.set(key, { at: Date.now(), chain });
    return chain;
  }
}
