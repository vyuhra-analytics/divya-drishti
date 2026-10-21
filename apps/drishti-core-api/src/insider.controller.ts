import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import { INSIDER_TICKERS, parseForm4, recentForm4, type InsiderTrade } from "@drishti/shared";

const FILINGS = 12; // newest Form 4s read per company
const TTL_MS = 3600_000;
const cache = new Map<string, { at: number; trades: InsiderTrade[] }>();

/**
 * Recent insider transactions (SEC Form 4) of one tracked energy major, newest first. Cached 1 h; sec.gov
 * asks for a contact in the User-Agent, taken from SEC_EDGAR_CONTACT (never defaulted).
 * GET /insider?ticker=XOM
 */
@Controller("insider")
export class InsiderController {
  @Get()
  async trades(@Query("ticker") ticker = "XOM"): Promise<{ tickers: string[]; trades: InsiderTrade[] }> {
    const cik = INSIDER_TICKERS[ticker];
    if (!cik) throw new BadRequestException(`ticker must be one of ${Object.keys(INSIDER_TICKERS)}`);
    const contact = process.env.SEC_EDGAR_CONTACT?.trim();
    if (!contact) throw new ServiceUnavailableException("Set SEC_EDGAR_CONTACT in .env (your contact for sec.gov's User-Agent) to load insider trades");
    const tickers = Object.keys(INSIDER_TICKERS);
    const hit = cache.get(ticker);
    if (hit && Date.now() - hit.at < TTL_MS) return { tickers, trades: hit.trades };

    const get = async (url: string) => {
      const res = await fetch(url, { headers: { "User-Agent": `DivyaDrishti ${contact}`, Accept: "application/json, text/xml" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new ServiceUnavailableException(`SEC ${res.status}`);
      return res;
    };
    const subs = await (await get(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`)).json();
    const filings = recentForm4(subs, FILINGS);
    const trades: InsiderTrade[] = [];
    // concurrency 3: well under sec.gov's 10 requests/s limit
    for (let i = 0; i < filings.length; i += 3) {
      const batch = await Promise.all(
        filings.slice(i, i + 3).map(async (f) => {
          const dir = `https://www.sec.gov/Archives/edgar/data/${cik}/${f.accession.replace(/-/g, "")}`;
          const xml = await (await get(`${dir}/${f.doc}`)).text();
          return parseForm4(xml, ticker, `${dir}/${f.accession}-index.htm`);
        }),
      ).catch(() => []);
      trades.push(...batch.flat());
    }
    trades.sort((a, b) => b.date.localeCompare(a.date));
    cache.set(ticker, { at: Date.now(), trades });
    return { tickers, trades };
  }
}
