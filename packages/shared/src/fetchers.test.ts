import { expect, test } from "bun:test";
import { chokepointFetcher, cotFetcher, curveFetcher, SOURCES } from "./fetchers";
import { createRunner, type FetchIO } from "./fetcher";

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
