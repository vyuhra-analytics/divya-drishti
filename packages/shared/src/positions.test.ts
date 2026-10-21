import { expect, test } from "bun:test";
import { parseUpstoxPositions, positionContext } from "./positions";

const rows = [
  { exchange: "MCX", trading_symbol: "CRUDEOIL 19 NOV 26 FUT", quantity: 100, average_price: 9300.5, last_price: 9384, pnl: 8350 },
  { exchange: "MCX", trading_symbol: "NATURALGAS 24 NOV 26 FUT", quantity: -1250, average_price: null, sell_price: 282.1, last_price: 280.2, pnl: 2375 },
  { exchange: "MCX", trading_symbol: "CRUDEOIL 9500 CE 17 NOV 26", quantity: -100, average_price: 600, last_price: 580, pnl: 2000 },
  { exchange: "MCX", trading_symbol: "CRUDEOILM 19 NOV 26 FUT", quantity: 0, pnl: 150 }, // closed during the day
  { exchange: "MCX", trading_symbol: "GOLD 05 DEC 26 FUT", quantity: 1, pnl: 10 }, // not ours
  { exchange: "NSE", trading_symbol: "CRUDEOIL", quantity: 5, pnl: 1 }, // wrong exchange
];

test("parseUpstoxPositions keeps open positions in our four MCX underlyings", () => {
  const p = parseUpstoxPositions(rows);
  expect(p.map((x) => [x.symbol, x.kind, x.netQty])).toEqual([
    ["MCX:CRUDEOIL", "future", 100],
    ["MCX:NATURALGAS", "future", -1250],
    ["MCX:CRUDEOIL", "option", -100],
  ]);
  expect(p[0]).toMatchObject({ avgPrice: 9300.5, pnl: 8350, lastPrice: 9384 });
  expect(p[1].avgPrice).toBe(282.1); // short: falls back to the average sell price
});

test("positionContext tells open, flat and unavailable apart", () => {
  const p = parseUpstoxPositions(rows);
  expect(positionContext("MCX:CRUDEOIL", p)).toMatchObject({ status: "open", side: "long", netQty: 100, pnl: 8350, optionPositionsOpen: 1 });
  expect(positionContext("MCX:NATURALGAS", p)).toMatchObject({ status: "open", side: "short" });
  expect(positionContext("MCX:CRUDEOILM", p)).toEqual({ status: "flat", optionPositionsOpen: undefined });
  expect(positionContext("MCX:CRUDEOIL", undefined)).toEqual({ status: "unavailable" });
});
