import { expect, test } from "bun:test";
import { currentRates, fixedRiskLots, legCosts, lotUnits, roundTrip, UPSTOX_MCX_RATES } from "./costs";

test("lotUnits reads the units per lot from the instrument", () => {
  expect(lotUnits("MCX:CRUDEOIL")).toBe(100);
  expect(lotUnits("MCX:CRUDEOILM")).toBe(10);
  expect(lotUnits("MCX:NATURALGAS")).toBe(1250);
  expect(lotUnits("MCX:NATGASMINI")).toBe(250);
  expect(lotUnits("NOPE")).toBeUndefined();
});

test("legCosts on one MCX crude lot at 9,400: sell side carries CTT, buy side carries stamp duty", () => {
  const turnover = 9400 * 100; // ₹9,40,000
  const sell = legCosts("future", "sell", 9400, 100, 1);
  expect(sell.turnover).toBe(turnover);
  expect(sell.brokerage).toBe(30); // Upstox's own API says Rs 30 per order (2026-10-22)
  expect(sell.ctt).toBeCloseTo(94, 9); // 0.01%
  expect(sell.exchange).toBeCloseTo(19.74, 9); // 0.0021%
  expect(sell.sebi).toBeCloseTo(0.94, 9); // ₹10 per crore
  expect(sell.stamp).toBe(0);
  expect(sell.gst).toBeCloseTo((30 + 19.74 + 0.94) * 0.18, 9);
  expect(sell.total).toBeCloseTo(30 + 94 + 19.74 + 0.94 + (30 + 19.74 + 0.94) * 0.18, 9);
  const buy = legCosts("future", "buy", 9400, 100, 1);
  expect(buy.ctt).toBe(0);
  expect(buy.stamp).toBeCloseTo(18.8, 9); // 0.002%
});

test("options use the premium turnover rates", () => {
  const sell = legCosts("option", "sell", 500, 100, 1); // premium ₹500 × 100 = ₹50,000
  expect(sell.ctt).toBeCloseTo(25, 9); // 0.05%
  expect(sell.exchange).toBeCloseTo(20.9, 9); // 0.0418%
});

test("roundTrip bridges gross to net and gives the breakeven move", () => {
  const long = roundTrip("future", "buy", 9400, 9450, 100, 2);
  expect(long.gross).toBe(50 * 100 * 2);
  expect(long.net).toBeCloseTo(long.gross - long.costs.total, 9);
  expect(long.breakevenPoints).toBeCloseTo(long.costs.total / 200, 9);
  const short = roundTrip("future", "sell", 9400, 9450, 100, 1);
  expect(short.gross).toBe(-5000); // price rose against the short
  // same prices, same lots: the round trip costs the same whichever side opens
  expect(roundTrip("future", "buy", 9400, 9400, 100, 1).costs.total).toBeCloseTo(roundTrip("future", "sell", 9400, 9400, 100, 1).costs.total, 9);
  expect(UPSTOX_MCX_RATES.gst).toBe(0.18);
});

test("fixedRiskLots keeps the loss at the stop, costs included, inside the budget", () => {
  const i = { side: "buy" as const, equity: 500_000, riskPct: 1, entry: 9400, stop: 9380, units: 100 };
  const s = fixedRiskLots(i)!;
  expect(s.riskBudget).toBe(5000);
  // each lot loses 20 × 100 = 2,000 plus costs, so two lots (~4,100) fit and three (~6,100) do not
  expect(s.lots).toBe(2);
  expect(s.riskAtStop).toBeLessThanOrEqual(5000);
  expect(s.riskAtStop).toBeGreaterThan(4000);
  expect(fixedRiskLots({ ...i, riskPct: 0.1 })!.lots).toBe(0); // one lot (~2,100) is more than ₹500
  expect(fixedRiskLots({ ...i, stop: 9420 })).toBeUndefined(); // stop above a long's entry
  expect(fixedRiskLots({ ...i, equity: 0 })).toBeUndefined();
  const short = fixedRiskLots({ ...i, side: "sell", stop: 9420 })!;
  expect(short.lots).toBe(2);
});

test("currentRates: an untouched old default table takes the new defaults, an edited one is kept", () => {
  const old = { ...UPSTOX_MCX_RATES, brokerageFlat: 20 };
  expect(currentRates(old)).toBe(UPSTOX_MCX_RATES);
  const edited = { ...old, exchangeFutures: 0.000026 };
  expect(currentRates(edited)).toBe(edited);
  const chosen = { ...UPSTOX_MCX_RATES, brokerageFlat: 25 };
  expect(currentRates(chosen)).toBe(chosen);
  expect(currentRates(UPSTOX_MCX_RATES)).toBe(UPSTOX_MCX_RATES);
});
