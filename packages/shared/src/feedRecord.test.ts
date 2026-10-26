import { describe, expect, it } from "bun:test";
import { FeedThrottle, optionRow, quoteRow, type FeedRow } from "./feedRecord";
import type { OptionQuote } from "./optionQuote";

const row = (o: Partial<FeedRow> = {}): FeedRow => ({ key: "MCX_FO|1", recvAt: 1_000, tradeAt: 1_000, price: 100, volume: 10, bid: 99, ask: 101, bidQty: 5, askQty: 5, oi: 50, ...o });

describe("FeedThrottle", () => {
  it("keeps the first sight of a key and every trade (price or volume moved), however fast", () => {
    const t = new FeedThrottle(1000);
    expect(t.keep(row())).toBe(true);
    expect(t.keep(row({ recvAt: 1_010, price: 101 }))).toBe(true);
    expect(t.keep(row({ recvAt: 1_020, price: 101, volume: 12 }))).toBe(true);
  });

  it("drops an identical repeat", () => {
    const t = new FeedThrottle(1000);
    t.keep(row());
    expect(t.keep(row({ recvAt: 5_000 }))).toBe(false);
  });

  it("thins book-only changes to one per gap, then keeps the next after the gap", () => {
    const t = new FeedThrottle(1000);
    t.keep(row());
    expect(t.keep(row({ recvAt: 1_200, bid: 98 }))).toBe(false);
    expect(t.keep(row({ recvAt: 2_100, bid: 98 }))).toBe(true);
    expect(t.keep(row({ recvAt: 2_200, bidQty: 7 }))).toBe(false);
  });

  it("a gap of 0 keeps every book change; keys are independent", () => {
    const t = new FeedThrottle(0);
    t.keep(row());
    expect(t.keep(row({ recvAt: 1_001, ask: 102 }))).toBe(true);
    expect(t.keep(row({ key: "MCX_FO|2" }))).toBe(true);
  });
});

describe("rows", () => {
  it("an option row carries depth, IV and greeks; a futures row is keyed by symbol", () => {
    const q: OptionQuote = { key: "MCX_FO|9", price: 50, time: 7, recvAt: 9, depth: [{ bidP: 49, bidQ: 3, askP: 51, askQ: 4 }], iv: 31.2, delta: 0.4, theta: -1, gamma: 0.01, vega: 2, rho: 0.1, oi: 10, volume: 3 };
    expect(optionRow(q)).toMatchObject({ key: "MCX_FO|9", recvAt: 9, tradeAt: 7, iv: 31.2, delta: 0.4, depth: q.depth });
    expect(quoteRow({ symbol: "MCX:CRUDEOIL", price: 9500, time: 5, source: "upstox", delayedBy: 0, bid: 9499, ask: 9501, oi: 1 }, 6)).toMatchObject({ key: "MCX:CRUDEOIL", recvAt: 6, tradeAt: 5, bid: 9499, ask: 9501, oi: 1 });
  });
});
