import { expect, test } from "bun:test";
import { atmStrike, buildRows, expiriesOf, maxPain, mergeChains, pcr, pickStrikes, type OptionContract } from "./options";

const day = 86_400_000;
const c = (strike: number, type: "CE" | "PE", expiry: number, underlying = "CRUDEOIL"): OptionContract => ({
  instrument_key: `${type}${strike}@${expiry}`,
  trading_symbol: `${underlying} ${strike} ${type}`,
  instrument_type: type,
  underlying_symbol: underlying,
  underlying_key: "FUT",
  strike_price: strike,
  expiry,
});

test("expiriesOf: upcoming only, soonest first, per underlying", () => {
  const now = Date.UTC(2026, 9, 21);
  const list = [c(9000, "CE", now + 27 * day), c(9000, "CE", now + 56 * day), c(9000, "CE", now - 3 * day), c(100, "CE", now + 2 * day, "NATURALGAS")];
  expect(expiriesOf(list, "CRUDEOIL", now)).toEqual(["2026-11-17", "2026-12-16"]);
  expect(expiriesOf(list, "NATURALGAS", now)).toEqual(["2026-10-23"]);
});

test("atmStrike / pickStrikes centre on spot and clamp at the ends", () => {
  const strikes = [9000, 9050, 9100, 9150, 9200, 9250, 9300];
  expect(atmStrike(strikes, 9132)).toBe(9150);
  expect(atmStrike(strikes, 9125)).toBe(9100); // tie → lower
  expect(pickStrikes(strikes, 9132, 2)).toEqual([9050, 9100, 9150, 9200, 9250]); // ATM 9150, two either side
  expect(pickStrikes(strikes, 9132, 1)).toEqual([9100, 9150, 9200]);
  expect(pickStrikes(strikes, 8000, 2)).toEqual([9000, 9050, 9100]); // clamped at the low end
  expect(pickStrikes([], 9000)).toEqual([]);
});

test("buildRows merges quotes and greeks into one row per strike (iv as percent)", () => {
  const exp = 1;
  const contracts = [c(9100, "CE", exp), c(9100, "PE", exp)];
  const quotes = new Map([
    [contracts[0].instrument_key, { last_price: 602, net_change: -105.2, oi: 953, volume: 13022, depth: { buy: [{ price: 600.2 }], sell: [{ price: 603.3 }] } }],
  ]);
  const greeks = new Map([[contracts[0].instrument_key, { iv: 0.4857, delta: 0.59, theta: -8.7, vega: 10 }]]);
  const rows = buildRows(contracts, quotes, greeks);
  expect(rows).toHaveLength(1);
  expect(rows[0].ce).toMatchObject({ ltp: 602, bid: 600.2, ask: 603.3, oi: 953, iv: 48.57, delta: 0.59 });
  expect(rows[0].pe).toEqual({ key: contracts[1].instrument_key, ukey: contracts[1].instrument_key }); // the Upstox key is kept: the live feed subscribes by it
  expect(rows[0].ce!.ukey).toBe(contracts[0].instrument_key);
});

test("pcr and maxPain from open interest", () => {
  // classic example: pain is lowest where total payout to holders is smallest
  const rows = [
    { strike: 100, ce: { key: "a", oi: 10 }, pe: { key: "b", oi: 40 } },
    { strike: 110, ce: { key: "c", oi: 30 }, pe: { key: "d", oi: 30 } },
    { strike: 120, ce: { key: "e", oi: 40 }, pe: { key: "f", oi: 10 } },
  ];
  expect(pcr(rows)).toBe(1); // 80 / 80
  expect(maxPain(rows)).toBe(110); // payout(100)=30*10+40*20=1100; (110)=10*10+10*10=200; (120)=10*20+30*10=500
  expect(pcr([{ strike: 1, pe: { key: "x", oi: 5 } }])).toBeUndefined();
  expect(maxPain([])).toBeUndefined();
});

test("mergeChains keeps the Upstox instrument key of a leg whose prices come from TradingView", () => {
  const tvLeg = { key: "MCX:CRUDEOIL261117C9450", ltp: 500, bid: 499, ask: 501, iv: 50, delta: 0.5 };
  const upLeg = { key: "MCX_FO|582939", ukey: "MCX_FO|582939", ltp: 502, oi: 1000, volume: 10 };
  const base = { underlying: "CRUDEOIL", expiry: "2026-11-17", expiries: ["2026-11-17"], updatedAt: 1 };
  const merged = mergeChains({ ...base, source: "tradingview", rows: [{ strike: 9450, ce: tvLeg }] }, { ...base, source: "upstox", rows: [{ strike: 9450, ce: upLeg }] });
  expect(merged.rows[0].ce).toMatchObject({ key: "MCX:CRUDEOIL261117C9450", ukey: "MCX_FO|582939", ltp: 502, oi: 1000 });
  const none = mergeChains({ ...base, source: "tradingview", rows: [{ strike: 9500, ce: tvLeg }] }, { ...base, source: "upstox", rows: [] });
  expect(none.rows[0].ce!.ukey).toBeUndefined(); // no Upstox contract for this strike: nothing to subscribe
});
