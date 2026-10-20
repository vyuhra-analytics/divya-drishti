import { expect, test } from "bun:test";
import { nextTick } from "./feed";

test("nextTick keeps symbol, stamps time, moves price within bounds", () => {
  const prev = { symbol: "TCS", time: 0, price: 1000, size: 1 };
  expect(nextTick(prev, 5, () => 0.5)).toEqual({ symbol: "TCS", time: 5, price: 1000, size: 51 });
  expect(nextTick(prev, 5, () => 1).price).toBe(1001.5);
  expect(nextTick(prev, 5, () => 0).price).toBe(998.5);
  expect(nextTick({ ...prev, price: 0.05 }, 5, () => 0).price).toBe(0.05);
});
