// The sources whose real responses are recorded as fixtures, each with the check a good response must pass.
// `bun run fixtures:refresh` records them; the contract test replays them. A failing check after a refresh means the provider changed.
import { parseWngsr, parseWpsr, parseFredCsv } from "./actuals";
import { summarizeTransits } from "./chokepoints";
import { createRunner, type FetchIO } from "./fetcher";
import { chokepointFetcher, cotFetcher, curveFetcher, jodiFetcher } from "./fetchers";
import { parseEia } from "./eia";
import type { shrink } from "./fixtures";
import { parseYahooCandles } from "./index";
import { summarizeJodi } from "./jodi";

type ShrinkOpts = NonNullable<Parameters<typeof shrink>[1]>;

export interface FixtureSample {
  id: string;
  /** environment variables needed to record it (replay uses dummies) */
  needs?: readonly string[];
  shrink?: ShrinkOpts;
  /** run the real code path and return what it produced */
  run(io: FetchIO): Promise<unknown>;
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
    run: (io) => createRunner(io)(cotFetcher, { market: "wti", weeks: 10 }).then((r) => r.data),
    check: (rows) => (rows.length >= 5 && rows.every((r: any) => num(r.openInterest) && num(r.managedMoney.net)) ? undefined : "expected 5+ rows with open interest and a managed-money net"),
  },
  {
    id: "imf-portwatch",
    shrink: { maxItems: 400 },
    run: (io) => createRunner(io)(chokepointFetcher, { id: "hormuz" }).then((r) => r.data),
    check: (days) => (days.length >= 100 && summarizeTransits(days)?.asOf ? undefined : "expected 100+ daily rows with a latest date"),
  },
  {
    id: "tv-curve",
    run: (io) => createRunner(io)(curveFetcher, { symbol: "NYMEX:CL" }).then((r) => r.data),
    check: (pts) => (pts.length >= 3 && pts.every((p: any) => num(p.price) && num(p.expiry)) ? undefined : "expected 3+ priced contracts"),
  },
  {
    id: "jodi",
    // the real files are ~12 MB: keep the header and the five countries' crude rows only
    shrink: { keepLine: (l) => /^(IN|US|CN|SA|JP),[^,]*,CRUDEOIL,/.test(l) },
    run: (io) => createRunner(io)(jodiFetcher, {}).then((r) => r.data),
    check: (points) => (summarizeJodi(points, "US").some((s) => s.latest && s.flow === "REFINOBS") ? undefined : "expected US refinery intake"),
  },
  {
    id: "eia-wpsr-csv",
    run: async (io) => parseWpsr(await text(io, "https://ir.eia.gov/wpsr/table1.csv")),
    check: (w) => (w && num(w.weekEnding) && Object.keys(w.change).length > 5 ? undefined : "expected a week ending and 5+ rows of changes"),
  },
  {
    id: "eia-wngsr-csv",
    run: async (io) => parseWngsr(await text(io, "https://ir.eia.gov/ngs/wngsr.csv")),
    check: (w) => (w && num(w.weekEnding) && num(w.netChange) ? undefined : "expected a week ending and a net change"),
  },
  {
    id: "fred-cpi-csv",
    run: async (io) => parseFredCsv(await text(io, "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL")),
    check: (pts) => (pts.length >= 24 && pts.every((p: any) => num(p.value)) ? undefined : "expected 24+ monthly points"),
  },
  {
    id: "yahoo-chart",
    run: async (io) => parseYahooCandles(await json(io, "https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=5m&range=1d")),
    check: (bars) => (bars.length >= 20 && bars.every((b: any) => num(b.close) && b.high >= b.low) ? undefined : "expected 20+ consistent 5m bars"),
  },
  {
    id: "eia-v2-stocks",
    needs: ["EIA_API_KEY"],
    // the key is scrubbed from the recorded URL; replay needs no key
    run: async (io) => parseEia(await json(io, `https://api.eia.gov/v2/seriesid/PET.WCESTUS1.W?api_key=${io.env.EIA_API_KEY ?? "replay"}&length=60`)),
    check: (pts) => (pts.length >= 50 && pts.every((p: any) => num(p.value)) ? undefined : "expected 50+ weekly readings"),
  },
];
