import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import { compareCosts, instrument, legCosts, LruCache, lotUnits, parseUpstoxCharges, upstoxChargesUrl, type CostCheck, type Kind, type Side } from "@drishti/shared";
import { Db } from "./db";
import { loadFronts } from "./history";

const CACHE_MS = 10 * 60_000;
const checks = new LruCache<{ at: number; check: CostCheck }>(64);

const KEY = /^MCX_FO\|\d{3,8}$/;
const whole = (v: string | undefined, lo: number, hi: number) => (v !== undefined && /^\d+$/.test(v) && +v >= lo && +v <= hi ? +v : undefined);

/**
 * What one order costs according to Upstox itself, set against our cost table (`costs.ts`), so the table is checked against the
 * real calculation instead of trusted. A futures leg is named by `symbol` (the front month is looked up); any leg can be named by an
 * Upstox instrument `key` plus the `units` it trades in (an option needs its key: the contract is the strike and expiry).
 * GET /costs/check?symbol=MCX:CRUDEOIL|key=MCX_FO|573422&units=100&kind=future|option&side=buy|sell&price=9350&lots=1
 * Read-only; the Upstox token never leaves this process.
 */
@Controller("costs")
export class CostsController {
  constructor(private readonly db: Db) {}

  @Get("check")
  async check(
    @Query("symbol") symbol?: string,
    @Query("key") key?: string,
    @Query("units") unitsText?: string,
    @Query("kind") kindText?: string,
    @Query("side") sideText?: string,
    @Query("price") priceText?: string,
    @Query("lots") lotsText?: string,
  ): Promise<CostCheck & { key: string; fetchedAt: number }> {
    const kind = kindText as Kind;
    if (kind !== "future" && kind !== "option") throw new BadRequestException("kind must be future or option");
    const side = sideText as Side;
    if (side !== "buy" && side !== "sell") throw new BadRequestException("side must be buy or sell");
    const price = priceText && /^\d+(\.\d+)?$/.test(priceText) ? Number(priceText) : NaN;
    if (!(price > 0 && price <= 1_000_000)) throw new BadRequestException("price must be a positive number");
    const lots = lotsText === undefined ? 1 : whole(lotsText, 1, 100);
    if (lots === undefined) throw new BadRequestException("lots must be a whole number from 1 to 100");
    if ((symbol === undefined) === (key === undefined)) throw new BadRequestException("give either symbol (a future) or key (any contract), not both");

    let units: number | undefined;
    let instrumentKey = key;
    if (symbol !== undefined) {
      const inst = instrument(symbol);
      if (!inst || inst.exchange !== "MCX" || !inst.upstox) throw new BadRequestException("symbol must be one of our MCX instruments");
      if (kind !== "future") throw new BadRequestException("an option leg needs the contract's key, not a symbol");
      units = lotUnits(symbol);
      if (!units) throw new BadRequestException("this instrument has no lot size");
    } else {
      if (!KEY.test(key!)) throw new BadRequestException("key must look like MCX_FO|573422");
      units = whole(unitsText, 1, 100_000);
      if (units === undefined) throw new BadRequestException("units (per lot) must be a whole number up to 100000");
    }

    const token = (await this.db.redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim();
    if (!token) throw new ServiceUnavailableException("Upstox not connected: set UPSTOX_ACCESS_TOKEN or log in from Settings → Data feeds");
    if (symbol !== undefined) {
      const front = (await loadFronts(this.db.redis))?.[instrument(symbol)!.upstox!];
      if (!front) throw new ServiceUnavailableException("the front month is not known yet (is the stream running?)");
      instrumentKey = front.instrument_key;
    }

    const quantity = units * lots;
    const id = `${instrumentKey}|${quantity}|${price}|${side}|${kind}`;
    const hit = checks.get(id);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.check, key: instrumentKey!, fetchedAt: hit.at };
    const res = await fetch(upstoxChargesUrl(instrumentKey!, quantity, price, side), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!res) throw new ServiceUnavailableException("Upstox unreachable");
    if (!res.ok) throw new ServiceUnavailableException(`Upstox ${res.status}`);
    const upstox = parseUpstoxCharges(await res.json().catch(() => null));
    if (!upstox) throw new ServiceUnavailableException("Upstox answered in a format we do not recognise");
    const check = compareCosts(upstox, legCosts(kind, side, price, units, lots));
    checks.set(id, { at: Date.now(), check });
    return { ...check, key: instrumentKey!, fetchedAt: Date.now() };
  }
}
