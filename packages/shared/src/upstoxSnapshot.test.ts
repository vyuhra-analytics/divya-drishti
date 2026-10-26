import { describe, expect, it } from "bun:test";
import { pieces, snapshotRow, snapshotRows } from "./upstoxSnapshot";

// shapes recorded from the live API on 2026-10-26 (values trimmed)
const traded = {
  ohlc: { open: 749.0, high: 760.6, low: 730.6, close: 758.8 },
  depth: { buy: [{ quantity: 2, price: 757.1, orders: 1 }, { quantity: 0, price: 0.0, orders: 0 }], sell: [{ quantity: 1, price: 758.8, orders: 1 }] },
  instrument_token: "MCX_FO|582934", symbol: "CRUDEOIL26NOV9200CE", last_price: 758.8, volume: 103, average_price: 744.94, oi: 839.0, net_change: -156.4,
  total_buy_quantity: 175.0, total_sell_quantity: 176.0, lower_circuit_limit: 8.3, upper_circuit_limit: 2355.9, last_trade_time: "1792989989000", oi_day_high: 0.0, oi_day_low: 0.0,
};
const untraded = {
  ohlc: { open: 0.0, high: 0.0, low: 0.0, close: 0.0 },
  depth: { buy: [{ quantity: 60, price: 5024.9, orders: 1 }], sell: [{ quantity: 60, price: 6082.9, orders: 1 }] },
  instrument_token: "MCX_FO|583802", symbol: "CRUDEOIL26NOV4000CE", last_price: 0.0, volume: 0, average_price: 0.0, oi: 0.0, net_change: -5775.6,
  total_buy_quantity: 60.0, total_sell_quantity: 60.0, lower_circuit_limit: 3854.4, upper_circuit_limit: 7535.9, last_trade_time: "0", oi_day_high: 0.0, oi_day_low: 0.0,
};
const greek = { last_price: 758.8, instrument_token: "MCX_FO|582934", ltq: 200, volume: 103, cp: 915.2, iv: 0.564422607421875, vega: 8.8583, gamma: 3.0e-4, theta: -11.0808, delta: 0.6495, oi: 839.0 };

describe("snapshotRow", () => {
  it("flattens a traded option with its greeks (IV in percent, empty depth levels dropped)", () => {
    const r = snapshotRow(1000, traded, greek)!;
    expect(r).toMatchObject({ key: "MCX_FO|582934", lastPrice: 758.8, lastTradeAt: 1792989989000, ltq: 200, volume: 103, oi: 839, prevClose: 915.2, lowerCircuit: 8.3, upperCircuit: 2355.9, iv: 56.44, delta: 0.6495, open: 749 });
    expect(r.depth).toEqual({ buy: [{ quantity: 2, price: 757.1, orders: 1 }], sell: [{ quantity: 1, price: 758.8, orders: 1 }] });
  });

  it("keeps an untraded contract's book and circuit limits, with no price, trade time or greeks", () => {
    const r = snapshotRow(1000, untraded, { instrument_token: "MCX_FO|583802", ltq: 0, cp: 5775.6, iv: 0.0, delta: 1.0 })!;
    expect(r.lastPrice).toBeUndefined();
    expect(r.lastTradeAt).toBeUndefined();
    expect(r.iv).toBeUndefined();
    expect(r.delta).toBeUndefined(); // delta 1.0 with IV 0 is the API's placeholder, not a measurement
    expect(r.depth?.buy[0].price).toBe(5024.9);
    expect(r.upperCircuit).toBe(7535.9);
    expect(r.netChange).toBe(-5775.6);
  });

  it("refuses an entry with no instrument token", () => expect(snapshotRow(1, { last_price: 5 })).toBeUndefined());
});

describe("snapshotRows and pieces", () => {
  it("joins the quote and greek maps by instrument token, quotes without greeks still count", () => {
    const rows = snapshotRows(5, { a: traded, b: untraded }, { x: greek });
    expect(rows.map((r) => r.key)).toEqual(["MCX_FO|582934", "MCX_FO|583802"]);
    expect(rows[0].iv).toBe(56.44);
    expect(rows[1].iv).toBeUndefined();
  });

  it("splits into pieces of at most the size", () => {
    expect(pieces([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(pieces([], 3)).toEqual([]);
  });
});
