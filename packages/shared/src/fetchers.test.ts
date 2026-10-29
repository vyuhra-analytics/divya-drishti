import { expect, test } from "bun:test";
import { chokepointFetcher, cotFetcher, curveFetcher, eiaGasFetcher, eiaScheduleFetcher, eiaSeriesFetcher, eiaWpsrFetcher, fredFetcher, rssFetcher, SOURCES } from "./fetchers";
import { createRunner, SourceError, type FetchIO } from "./fetcher";

/** a fake network keyed by URL substring: returns the recorded-style body for the first match, 404 otherwise */
function net(routes: Record<string, unknown>) {
  const urls: string[] = [];
  const io: FetchIO = {
    fetch: (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      urls.push(url + (init?.body ? ` ${init.body}` : ""));
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) return new Response("not found", { status: 404 });
      return typeof hit[1] === "string" ? new Response(hit[1]) : Response.json(hit[1]);
    }) as never,
    env: {},
    now: () => Date.UTC(2026, 9, 21),
  };
  return { io, urls };
}

test("cotFetcher asks Socrata for the contract code from our table and parses the rows", async () => {
  const row = (d: string) => ({
    report_date_as_yyyy_mm_dd: `${d}T00:00:00.000`, open_interest_all: "2000000",
    m_money_positions_long_all: "300000", m_money_positions_short_all: "100000", prod_merc_positions_long: "500000", prod_merc_positions_short: "900000",
    swap_positions_long_all: "200000", swap__positions_short_all: "300000", other_rept_positions_long: "100000", other_rept_positions_short: "50000",
    nonrept_positions_long_all: "40000", nonrept_positions_short_all: "30000",
  });
  const { io, urls } = net({ "publicreporting.cftc.gov": [row("2026-10-13"), row("2026-10-06")] });
  const { data } = await createRunner(io)(cotFetcher, { market: "wti", weeks: 156 });
  expect(data.map((r) => r.managedMoney.net)).toEqual([200000, 200000]);
  expect(decodeURIComponent(urls[0])).toContain("cftc_contract_market_code='067651'");
  expect(urls[0]).toContain("%24limit=156");
});

test("chokepointFetcher filters on PortWatch's own name for the lane and parses the daily rows", async () => {
  const { io, urls } = net({ "arcgis.com": { features: [{ attributes: { date: "2026-10-18", n_tanker: 2, n_total: 4, capacity_tanker: 19163 } }, { attributes: { date: "2026-10-17", n_tanker: 0, n_total: 0, capacity_tanker: 0 } }] } });
  const { data } = await createRunner(io)(chokepointFetcher, { id: "hormuz" });
  expect(data.map((d) => [d.date, d.tankers])).toEqual([["2026-10-17", 0], ["2026-10-18", 2]]);
  expect(decodeURIComponent(urls[0]).replace(/\+/g, " ")).toContain("portname='Strait of Hormuz'");
});

test("curveFetcher posts the dated contract codes and needs two contracts", async () => {
  const scan = { data: [{ s: "NYMEX:CLZ2026", d: [98.96, 54204, 20261120] }, { s: "NYMEX:CLF2027", d: [97.18, 17064, 20261221] }] };
  const { io, urls } = net({ "scanner.tradingview.com": scan });
  const { data } = await createRunner(io)(curveFetcher, { symbol: "NYMEX:CL" });
  expect(data.map((p) => p.code)).toEqual(["NYMEX:CLZ2026", "NYMEX:CLF2027"]);
  expect(urls[0]).toContain("NYMEX:CLX2026"); // codes built from the injected clock: October 2026 onwards
  const one = net({ "scanner.tradingview.com": { data: [scan.data[0]] } });
  const thin = await createRunner(one.io)(curveFetcher, { symbol: "NYMEX:CL" }).catch((e) => e);
  expect(thin).toMatchObject({ kind: "nodata" }); // rows came back but only one live contract: a thin listing, not an outage
  expect(thin.message).toContain("only 1 live contract");
  const empty = net({ "scanner.tradingview.com": { data: [] } });
  await expect(createRunner(empty.io)(curveFetcher, { symbol: "NYMEX:CL" })).rejects.toThrow(/TradingView futures curve unavailable/); // nothing at all is still an outage
});

test("every source in the registry names its credentials and any fetcher that serves it", () => {
  const ids = SOURCES.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(SOURCES.find((s) => s.id === "eia")?.credentials).toEqual(["EIA_API_KEY"]);
  for (const s of SOURCES) expect(s.label.length).toBeGreaterThan(0);
});

test("fredFetcher asks for the series id it is given and parses the points; the id is encoded", async () => {
  const csv = ["observation_date,CPIAUCSL", ...Array.from({ length: 30 }, (_, i) => `2024-${String((i % 12) + 1).padStart(2, "0")}-01,${300 + i}`)].join("\n");
  const { io, urls } = net({ "fredgraph.csv": csv });
  const { data } = await createRunner(io)(fredFetcher, { seriesId: "CPIAUCSL" });
  expect(data.length).toBeGreaterThan(20);
  expect(urls[0]).toBe("https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL");
  await createRunner(io)(fredFetcher, { seriesId: "A&B" }).catch(() => undefined);
  expect(urls.at(-1)).toContain("id=A%26B");
});

test("the EIA weekly files: a file we cannot read is a failed fetch, never an empty actual, and a good copy is served stale when the file goes away", async () => {
  const garbage = net({ "wpsr/table1.csv": "<html>maintenance</html>", "wngsr.csv": "" });
  const run = createRunner(garbage.io);
  for (const f of [eiaWpsrFetcher, eiaGasFetcher]) {
    const e = await run(f as never, {}).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect((e as SourceError).kind).toBe("unavailable");
  }
  // a good copy, then the file disappears: the last good copy comes back marked stale
  const good = net({ "fredgraph.csv": ["DATE,X", ...Array.from({ length: 5 }, (_, i) => `2026-0${i + 1}-01,${i + 1}`)].join(String.fromCharCode(10)) });
  let t = Date.UTC(2026, 9, 21);
  let down = false;
  const run2 = createRunner({ ...good.io, fetch: ((u: string, i?: RequestInit) => (down ? Promise.resolve(new Response("", { status: 503 })) : good.io.fetch(u, i))) as never, now: () => t });
  expect((await run2(fredFetcher, { seriesId: "X" })).stale).toBeUndefined();
  t += 60_000;
  down = true;
  expect((await run2(fredFetcher, { seriesId: "X" })).stale).toBe(true);
});

test("the registry names the fetchers behind the EIA files and FRED", () => {
  expect(SOURCES.find((s) => s.id === "fred")!.fetcher).toBe("fred-series");
  expect(String(SOURCES.find((s) => s.id === "eia-csv")!.fetcher)).toContain("eia-wpsr-csv");
});

test("eiaSeriesFetcher: no key means no request and a hint; with a key it reads the series from our own table and summarises it", async () => {
  const none = net({});
  const e = await createRunner(none.io)(eiaSeriesFetcher, { id: "WCESTUS1" }).catch((x) => x);
  expect((e as SourceError).kind).toBe("credentials");
  expect(e.message).toContain("eia.gov/opendata");
  expect(none.urls).toHaveLength(0);
  const data = Array.from({ length: 12 }, (_, i) => ({ period: `2026-0${(i % 9) + 1}-${String(1 + i).padStart(2, "0")}`, value: 400000 + i * 100 }));
  const { io, urls } = net({ "api.eia.gov": { response: { data } } });
  const withKey: FetchIO = { ...io, env: { EIA_API_KEY: " k123 " } };
  const r = await createRunner(withKey)(eiaSeriesFetcher, { id: "WCESTUS1" });
  expect(r.data.id).toBe("WCESTUS1");
  expect(r.data.latest).toBeDefined();
  expect(urls[0]).toContain("/v2/seriesid/PET.WCESTUS1.W");
  expect(urls[0]).toContain("api_key=k123");
  expect(urls[0]).toContain("length=320");
  const empty = net({ "api.eia.gov": { response: { data: [] } } });
  const bad = await createRunner({ ...empty.io, env: { EIA_API_KEY: "k" } })(eiaSeriesFetcher, { id: "WCESTUS1" }).catch((x) => x);
  expect((bad as SourceError).kind).toBe("unavailable"); // no readings: a failed fetch, never an empty series
});

test("rssFetcher parses a feed with the given outlet and tags; a feed with no items is a failed fetch; eiaScheduleFetcher reads the page for its report", async () => {
  const xml = `<?xml version="1.0"?><rss><channel>${Array.from({ length: 3 }, (_, i) => `<item><title>Oil rises ${i}</title><link>https://x.test/${i}</link><pubDate>Wed, 21 Oct 2026 10:0${i}:00 GMT</pubDate></item>`).join("")}</channel></rss>`;
  const { io } = net({ "feed.test/a": xml, "feed.test/empty": "<rss><channel></channel></rss>" });
  const run = createRunner(io);
  const { data } = await run(rssFetcher, { url: "https://feed.test/a", name: "Test Wire", tags: ["oil"] });
  expect(data).toHaveLength(3);
  expect(data[0].source).toBe("Test Wire");
  expect((await run(rssFetcher, { url: "https://feed.test/empty", name: "T", tags: [] }).catch((x) => x)) as SourceError).toBeInstanceOf(SourceError);
  const sched = net({ "schedule.php": "<html>no holidays here</html>" });
  const s = await createRunner(sched.io)(eiaScheduleFetcher, { report: "WPSR" }).catch((x) => x);
  expect((s as SourceError).kind).toBe("unavailable"); // a page that lists no exception is a layout we no longer read
  expect(sched.urls[0]).toContain("eia.gov/petroleum/supply/weekly/schedule.php");
});
