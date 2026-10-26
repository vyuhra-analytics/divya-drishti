import { describe, expect, it } from "bun:test";
import { estimateFlow, type FlowRow } from "./orderFlow";

const T0 = Date.parse("2026-10-26T15:30:00Z"); // 21:00 IST
const row = (sec: number, over: Partial<FlowRow>): FlowRow => ({ time: T0 + sec * 1000, price: 100, volume: 0, bid: 99, ask: 101, bidQty: 5, askQty: 5, ...over });
const one = (rows: FlowRow[], tf = 60) => estimateFlow(rows, tf, 19_800);

describe("estimateFlow: who hit", () => {
  it("gives volume that traded at or through the prevailing ask to the buyer, and at or through the bid to the seller", () => {
    const [b] = one([row(0, { volume: 100 }), row(1, { price: 101, volume: 107 }), row(2, { price: 99, volume: 110 })]);
    expect(b).toMatchObject({ buy: 7, sell: 3, unclassified: 0, volume: 10, delta: 4 });
  });

  it("judges against the quote BEFORE the trade, not the one that follows it", () => {
    // the ask is 101 before the trade at 101; afterwards the book has moved up to 101/103: the trade was still a buy
    const [b] = one([row(0, { volume: 0 }), row(1, { price: 101, volume: 5, bid: 101, ask: 103 })]);
    expect(b.buy).toBe(5);
  });

  it("inside the spread: above the middle is a buy, below it a sell", () => {
    const wide = { bid: 90, ask: 110 };
    const [b] = one([row(0, { volume: 0, ...wide, price: 100 }), row(1, { price: 105, volume: 4, ...wide }), row(2, { price: 95, volume: 6, ...wide })]);
    expect(b).toMatchObject({ buy: 4, sell: 2 });
  });

  it("on the middle it uses the tick rule, then the last direction, and is unclassified only when it has neither", () => {
    const wide = { bid: 90, ask: 110 };
    const rows = [row(0, { volume: 0, price: 98, ...wide }), row(1, { price: 100, volume: 3, ...wide }), row(2, { price: 100, volume: 5, ...wide })];
    const [b] = one(rows);
    expect(b).toMatchObject({ buy: 5, unclassified: 0 }); // 98 -> 100 is an uptick, then the same price keeps that direction
    const [c] = one([row(0, { volume: 0, price: 100, ...wide }), row(1, { price: 100, volume: 4, ...wide })]);
    expect(c).toMatchObject({ unclassified: 4, buy: 0, sell: 0, volume: 4 });
  });

  it("a contract with no last price, a volume that goes backwards and the first row give no volume", () => {
    const [b] = one([row(0, { volume: 50 }), row(1, { price: null, volume: 55 }), row(2, { volume: 10 }), row(3, { price: 101, volume: 12 })]);
    expect(b.volume).toBe(5 + 2); // the untraded 5 counts as volume but has no side; the reset is skipped; 10 -> 12 is a buy
    expect(b).toMatchObject({ unclassified: 5, buy: 2 });
  });
});

describe("estimateFlow: candles", () => {
  it("splits rows into buckets on the exchange's grid and restarts the running delta at each IST day", () => {
    const day2 = 24 * 3600;
    const out = one([row(0, { volume: 0 }), row(10, { price: 101, volume: 10 }), row(70, { price: 99, volume: 14 }), row(day2, { volume: 14 }), row(day2 + 5, { price: 101, volume: 20 })]);
    expect(out.map((b) => [b.buy, b.sell, b.delta, b.cumDelta])).toEqual([
      [10, 0, 10, 10],
      [0, 4, -4, 6], // the second minute carries on from the first
      [6, 0, 6, 6], // the next day starts again from zero
    ]);
    expect(out[1].time - out[0].time).toBe(60);
  });

  it("averages the book imbalance over the levels and the spread over the snapshots, and notes how many snapshots it had", () => {
    const depth = [{ bidQ: 30, askQ: 10 }, { bidQ: 10, askQ: 10 }]; // (40 - 20) / 60
    const [b] = one([row(0, { volume: 0, depth }), row(1, { volume: 0, bid: 98, ask: 102, depth: undefined, bidQty: 10, askQty: 30 })]);
    expect(b.imbalance).toBeCloseTo((20 / 60 + -0.5) / 2, 10);
    expect(b.spread).toBeCloseTo((2 + 4) / 2, 10);
    expect(b.msgs).toBe(2);
  });

  it("has no imbalance without a book and returns nothing for nothing", () => {
    expect(one([row(0, { bidQty: null, askQty: null, volume: 0 })])[0].imbalance).toBeUndefined();
    expect(one([])).toEqual([]);
  });
});
