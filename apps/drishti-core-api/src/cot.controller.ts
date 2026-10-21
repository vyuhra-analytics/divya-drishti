import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import { COT_DATASET, COT_MARKETS, LruCache, parseCot, type CotRow } from "@drishti/shared";

const TTL_MS = 3600_000; // weekly data, published Fridays: an hourly look is plenty
const FIELDS = [
  "report_date_as_yyyy_mm_dd", "open_interest_all", "change_in_open_interest_all",
  "m_money_positions_long_all", "m_money_positions_short_all", "m_money_positions_spread", "change_in_m_money_long_all", "change_in_m_money_short_all", "traders_m_money_long_all", "traders_m_money_short_all",
  "prod_merc_positions_long", "prod_merc_positions_short", "change_in_prod_merc_long", "change_in_prod_merc_short", "traders_prod_merc_long_all", "traders_prod_merc_short_all",
  "swap_positions_long_all", "swap__positions_short_all", "change_in_swap_long_all", "change_in_swap_short_all", "traders_swap_long_all", "traders_swap_short_all",
  "other_rept_positions_long", "other_rept_positions_short", "change_in_other_rept_long", "change_in_other_rept_short", "traders_other_rept_long_all", "traders_other_rept_short",
  "nonrept_positions_long_all", "nonrept_positions_short_all", "change_in_nonrept_long_all", "change_in_nonrept_short_all",
].join(",");
const cache = new LruCache<{ at: number; rows: CotRow[] }>(16);

/**
 * CFTC Commitments of Traders for WTI, Brent, RBOB and Henry Hub: managed money (speculators), producers, swap dealers and
 * others, long and short, weekly. Free and keyless (Socrata); positions as of Tuesday, published the Friday after.
 * GET /cot?market=wti&weeks=156
 */
@Controller("cot")
export class CotController {
  @Get()
  async cot(@Query("market") market = "wti", @Query("weeks") weeksParam?: string) {
    const m = COT_MARKETS.find((x) => x.id === market);
    if (!m) throw new BadRequestException(`market must be one of ${COT_MARKETS.map((x) => x.id)}`);
    const weeks = weeksParam === undefined ? 156 : Number(weeksParam);
    if (!Number.isInteger(weeks) || weeks < 10 || weeks > 520) throw new BadRequestException("weeks must be 10–520");

    const key = `${m.id}|${weeks}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return { market: { id: m.id, code: m.code, name: m.name }, rows: hit.rows, fetchedAt: hit.at };

    const url = new URL(`https://publicreporting.cftc.gov/resource/${COT_DATASET}.json`);
    url.searchParams.set("$select", FIELDS);
    url.searchParams.set("$where", `cftc_contract_market_code='${m.code}'`); // code comes from our own table, never from the caller
    url.searchParams.set("$order", "report_date_as_yyyy_mm_dd DESC");
    url.searchParams.set("$limit", String(weeks));
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) {
      if (hit) return { market: { id: m.id, code: m.code, name: m.name }, rows: hit.rows, fetchedAt: hit.at, stale: true }; // CFTC down: the last copy beats nothing
      throw new ServiceUnavailableException(`CFTC ${res?.status ?? "unreachable"}`);
    }
    const rows = parseCot((await res.json()) as any[]);
    cache.set(key, { at: Date.now(), rows });
    return { market: { id: m.id, code: m.code, name: m.name }, rows, fetchedAt: Date.now() };
  }
}
