// The sources whose real responses are recorded as fixtures, each with the check a good response must pass.
// `bun run fixtures:refresh` records them; the contract test replays them. A failing check after a refresh means the provider changed.
import { parseWpsrReport } from "./eiaReport";
import { financeCalendar, SOURCE_WINDOW, yahooCalendar } from "./calendarSources";
import { EIA_SCHEDULE_URLS, parseEiaGasSchedule, parseEiaPetroleumSchedule } from "./eiaSchedule";
import { summarizeTransits } from "./chokepoints";
import { createRunner, type FetchIO } from "./fetcher";
import { chokepointFetcher, cotFetcher, curveFetcher, eiaGasFetcher, eiaWpsrFetcher, fredFetcher } from "./fetchers";
import { parseEia } from "./eia";
import type { shrink } from "./fixtures";
import { parseYahooCandles } from "./index";
import { parseRss } from "./news";

type ShrinkOpts = NonNullable<Parameters<typeof shrink>[1]>;

export interface FixtureSample {
  id: string;
  /** the SOURCES registry entry behind it: its risk sets how often the canary probes it */
  source: string;
  /** environment variables needed to record it (replay uses dummies) */
  needs?: readonly string[];
  shrink?: ShrinkOpts;
  /** run the real code path and return what it produced */
  run(io: FetchIO): Promise<unknown>;
  /** how often the scheduled canary runs this one (default hourly; heavy downloads less often) */
  everyMs?: number;
  /** a problem with the result, or undefined when it looks like real, usable data */
  check(result: any): string | undefined;
}

const text = async (io: FetchIO, url: string) => {
  const res = await io.fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};
const json = async (io: FetchIO, url: string) => JSON.parse(await text(io, url));

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

export const FIXTURE_SAMPLES: FixtureSample[] = [
  {
    id: "cftc-cot",
    source: "cftc-cot",
    run: (io) => createRunner(io)(cotFetcher, { market: "wti", weeks: 10 }).then((r) => r.data),
    check: (rows) => (rows.length >= 5 && rows.every((r: any) => num(r.openInterest) && num(r.managedMoney.net)) ? undefined : "expected 5+ rows with open interest and a managed-money net"),
  },
  {
    id: "imf-portwatch",
    source: "imf-portwatch",
    shrink: { maxItems: 400 },
    run: (io) => createRunner(io)(chokepointFetcher, { id: "hormuz" }).then((r) => r.data),
    check: (days) => (days.length >= 100 && summarizeTransits(days)?.asOf ? undefined : "expected 100+ daily rows with a latest date"),
  },
  {
    id: "tv-curve",
    source: "tradingview",
    run: (io) => createRunner(io)(curveFetcher, { symbol: "NYMEX:CL" }).then((r) => r.data),
    check: (pts) => (pts.length >= 3 && pts.every((p: any) => num(p.price) && num(p.expiry)) ? undefined : "expected 3+ priced contracts"),
  },
  {
    id: "eia-wpsr-csv",
    source: "eia-csv",
    run: (io) => createRunner(io)(eiaWpsrFetcher, {}).then((r) => r.data),
    check: (w) => (w && num(w.weekEnding) && Object.keys(w.change).length > 5 ? undefined : "expected a week ending and 5+ rows of changes"),
  },
  {
    id: "eia-schedule",
    source: "eia-csv",
    run: async (io) => ({ wpsr: parseEiaPetroleumSchedule((await text(io, EIA_SCHEDULE_URLS.WPSR)) ?? ""), wngsr: parseEiaGasSchedule((await text(io, EIA_SCHEDULE_URLS.WNGSR)) ?? "") }),
    check: (r) => (r.wpsr.length >= 4 && r.wngsr.length >= 4 && [...r.wpsr, ...r.wngsr].every((x: any) => x.holiday && Number.isFinite(x.at) && x.at !== x.normalAt) ? undefined : "expected 4+ holiday exceptions on each EIA schedule page"),
  },
  {
    id: "finance-calendar",
    source: "finance-calendar",
    run: (io) => financeCalendar.fetch(io, io.now() - SOURCE_WINDOW.back, io.now() + SOURCE_WINDOW.ahead),
    check: (rows) => (rows.length >= 5 && rows.every((r: any) => r.code && Number.isFinite(r.at)) ? undefined : "expected 5+ US events with codes and release times"),
  },
  {
    id: "yahoo-calendar",
    source: "yahoo",
    run: (io) => yahooCalendar().fetch(io, io.now() - SOURCE_WINDOW.back, io.now() + SOURCE_WINDOW.ahead),
    check: (rows) => (rows.length >= 5 && rows.every((r: any) => r.title && Number.isFinite(r.at)) ? undefined : "expected 5+ US events with names and times"),
  },
  {
    id: "eia-wpsr-tables",
    source: "eia-csv",
    run: async (io) => {
      const files: Record<number, string | undefined> = {};
      for (let t = 1; t <= 9; t++) files[t] = await text(io, `https://ir.eia.gov/wpsr/table${t}.csv`);
      return parseWpsrReport(files);
    },
    check: (r) => (r && num(r.periodEnd) && r.rows.length > 150 && r.rows.some((x: any) => x.headline) ? undefined : "expected the nine tables of one week with a headline row"),
  },
  {
    id: "eia-wngsr-csv",
    source: "eia-csv",
    run: (io) => createRunner(io)(eiaGasFetcher, {}).then((r) => r.data),
    check: (w) => (w && num(w.weekEnding) && num(w.netChange) ? undefined : "expected a week ending and a net change"),
  },
  {
    id: "fred-cpi-csv",
    source: "fred",
    run: (io) => createRunner(io)(fredFetcher, { seriesId: "CPIAUCSL" }).then((r) => r.data),
    check: (pts) => (pts.length >= 24 && pts.every((p: any) => num(p.value)) ? undefined : "expected 24+ monthly points"),
  },
  {
    id: "yahoo-chart",
    source: "yahoo",
    run: async (io) => parseYahooCandles(await json(io, "https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=5m&range=5d")),
    check: (bars) => (bars.length >= 20 && bars.every((b: any) => num(b.close) && b.high >= b.low) ? undefined : "expected 20+ consistent 5m bars"),
  },
  ...(
    [
      ["rss-oilprice", "OilPrice.com", "https://oilprice.com/rss/main"],
      ["rss-cnbc", "CNBC", "https://www.cnbc.com/id/19836768/device/rss/rss.html"],
      ["rss-rigzone", "Rigzone", "https://www.rigzone.com/news/rss/rigzone_latest.aspx"],
      ["rss-google-oil", "Google News", "https://news.google.com/rss/search?q=oil%20when%3A1d&hl=en-IN&gl=IN&ceid=IN:en"],
    ] as const
  ).map(
    ([id, name, url]): FixtureSample => ({
      id,
      source: "rss",
      shrink: { maxItems: 15 },
      run: async (io) => parseRss(await text(io, url), name),
      check: (items) => (items.length >= 5 && items.every((i: any) => i.title && i.url && num(i.publishedAt)) ? undefined : "expected 5+ items with a title, link and time"),
    }),
  ),
  {
    id: "eia-v2-stocks",
    source: "eia",
    needs: ["EIA_API_KEY"],
    // the key is scrubbed from the recorded URL; replay needs no key
    run: async (io) => parseEia(await json(io, `https://api.eia.gov/v2/seriesid/PET.WCESTUS1.W?api_key=${io.env.EIA_API_KEY ?? "replay"}&length=60`)),
    check: (pts) => (pts.length >= 50 && pts.every((p: any) => num(p.value)) ? undefined : "expected 50+ weekly readings"),
  },
];
