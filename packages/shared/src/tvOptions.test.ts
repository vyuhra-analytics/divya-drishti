import { expect, test } from "bun:test";
import { buildTvChain, legPrice, parseTvOptions, tvUnderlyings } from "./tvOptions";
import { LruCache } from "./lru";
import { mergeChains, type Chain } from "./options";

// rows in TV_OPTION_COLUMNS order: bid, ask, theo, iv, delta, gamma, theta, vega, rho, strike, expiration, type, mode, underlying
// values taken from a real options/scan2 response for MCX:CRUDEOILX2026 (21 Oct 2026)
const U = "MCX:CRUDEOILX2026";
const row = (s: string, f: unknown[]) => ({ s, f });
const response = {
  totalCount: 6,
  symbols: [
    row("MCX:CRUDEOIL261117C7900", [1402.5, 1670.2, 1624.4, 0.5617759, 0.8913867, 0.000127, -4.873, 4.796, 5.0999, 7900, 20261117, "call", "streaming", U]),
    row("MCX:CRUDEOIL261117P7900", [80.1, 82.1, 80.6, 0.5617759, -0.1078661, 0.000127, -4.9156, 4.796, -0.825, 7900, 20261117, "put", "streaming", U]),
    row("MCX:CRUDEOIL261117C7950", [1315.9, 1708.3, 1579.1, 0.556603, 0.8854725, 0.000134, -5.019, 4.983, 5.092, 7950, 20261117, "call", "delayed_streaming_600", U]),
    row("MCX:CRUDEOIL261117P3850", [0.1, 0, 0.1, 0.9427878, -0.000157, 2.4e-7, -0.0269, 0.0156, -0.0012, 3850, 20261117, "put", "streaming", U]),
    row("MCX:CRUDEOIL261217C8000", [900, 950, 925, 0.5, 0.6, 0.0001, -3, 4, 3, 8000, 20261217, "call", "streaming", U]),
    row("MCX:CRUDEOIL261117X", [1, 2, 3, 0.5, 0.5, 0, 0, 0, 0, 7000, 20261117, "weird", "streaming", U]), // unknown type: skipped
  ],
};

test("parseTvOptions reads rows by column, keeps the type, expiry and lag, skips unknown types", () => {
  const rows = parseTvOptions(response);
  expect(rows).toHaveLength(5);
  expect(rows[0]).toMatchObject({ type: "call", strike: 7900, bid: 1402.5, ask: 1670.2, theo: 1624.4, delta: 0.8913867, delayedBy: 0, underlying: U });
  expect(new Date(rows[0].expiry).toISOString()).toBe("2026-11-17T00:00:00.000Z");
  expect(rows[2].delayedBy).toBe(600);
  expect(parseTvOptions({})).toEqual([]);
});

test("a leg is priced at the bid/ask midpoint, else at the theoretical price", () => {
  expect(legPrice({ bid: 80.1, ask: 82.1, theo: 80.6 })).toBeCloseTo(81.1, 6);
  expect(legPrice({ bid: 0.1, ask: 0, theo: 0.1 })).toBe(0.1); // no ask: theo
  expect(legPrice({})).toBeUndefined();
});

test("buildTvChain keeps one expiry, strikes around the future's price, IV in percent, no OI", () => {
  const rows = parseTvOptions(response);
  const exp = rows[0].expiry;
  const chain = buildTvChain(rows, { underlying: "CRUDEOIL", expiries: ["2026-11-17", "2026-12-17"], expiry: exp, spot: 7920, each: 1, now: 123 });
  expect(chain).toMatchObject({ underlying: "CRUDEOIL", expiry: "2026-11-17", spot: 7920, atm: 7900, source: "tradingview", delayedBy: 600, updatedAt: 123 });
  expect(chain.rows.map((r) => r.strike)).toEqual([3850, 7900, 7950]); // one strike either side of ATM; the December strike is a different expiry
  const r = chain.rows[1];
  expect(r.ce).toMatchObject({ ltp: 1536.35, iv: 56.17759, delta: 0.8913867, theo: 1624.4 });
  expect(r.pe!.bid).toBe(80.1);
  expect(chain.pcr).toBeUndefined();
  expect(chain.maxPain).toBeUndefined();
});

test("tvUnderlyings lists this month and the next as dated codes", () => {
  const now = Date.UTC(2026, 9, 21);
  expect(tvUnderlyings("CRUDEOIL", "MCX", now, 3)).toEqual([
    { code: "CRUDEOILV2026", ticker: "MCX:CRUDEOILV2026" },
    { code: "CRUDEOILX2026", ticker: "MCX:CRUDEOILX2026" },
    { code: "CRUDEOILZ2026", ticker: "MCX:CRUDEOILZ2026" },
  ]);
  expect(tvUnderlyings("NATURALGAS", "MCX", Date.UTC(2026, 11, 5), 2)[1].code).toBe("NATURALGASF2027"); // year rolls over
});

test("LruCache drops the least recently used entry past its cap", () => {
  const c = new LruCache<number>(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a"); // a is now newer than b
  c.set("c", 3);
  expect(c.get("b")).toBeUndefined();
  expect(c.get("a")).toBe(1);
  expect(c.size).toBe(2);
});

test("mergeChains puts Upstox open interest, volume and last trade on TradingView's live prices", () => {
  const exp = parseTvOptions(response)[0].expiry;
  const tv = buildTvChain(parseTvOptions(response), { underlying: "CRUDEOIL", expiries: ["2026-11-17"], expiry: exp, spot: 7920, each: 1, now: 1 });
  const up: Chain = {
    underlying: "CRUDEOIL", expiry: "2026-11-17", expiries: ["2026-11-17", "2026-12-16"], spot: 7915, lot: 100, updatedAt: 2, source: "upstox",
    rows: [
      { strike: 7900, ce: { key: "u1", ltp: 1500, change: 12, oi: 600, volume: 40, bid: 1, ask: 2 }, pe: { key: "u2", ltp: 81, oi: 900, volume: 70 } },
      { strike: 7950, ce: { key: "u3", oi: 100 }, pe: { key: "u4", oi: 300 } },
    ],
  };
  const m = mergeChains(tv, up);
  expect(m.source).toBe("combined");
  expect(m.expiries).toEqual(["2026-11-17", "2026-12-16"]);
  expect(m.spot).toBe(7920); // TradingView's live future
  expect(m.lot).toBe(100);
  const r = m.rows.find((x) => x.strike === 7900)!;
  expect(r.ce).toMatchObject({ ltp: 1500, oi: 600, volume: 40, change: 12, bid: 1402.5, iv: 56.17759, theo: 1624.4 }); // last trade from Upstox; bid, IV, theo stay TradingView's
  expect(m.rows.find((x) => x.strike === 3850)!.pe).toMatchObject({ bid: 0.1 }); // a strike Upstox lacks keeps TradingView numbers
  expect(m.pcr).toBeCloseTo((900 + 300) / (600 + 100), 6);
  expect(m.maxPain).toBeDefined();
});
