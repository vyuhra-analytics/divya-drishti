import { expect, test } from "bun:test";
import { applyTick } from "./index";

const t = (sec: number, price: number) => ({ symbol: "X", time: sec * 1000, price, size: 1 });

test("applyTick merges within bucket and rolls over on next", () => {
  let bar = applyTick(undefined, t(60, 10), 60);
  expect(bar).toEqual({ time: 60, open: 10, high: 10, low: 10, close: 10, volume: 1 });
  bar = applyTick(bar, t(90, 12), 60);
  bar = applyTick(bar, t(119, 9), 60);
  expect(bar).toEqual({ time: 60, open: 10, high: 12, low: 9, close: 9, volume: 3 });
  bar = applyTick(bar, t(120, 11), 60);
  expect(bar).toEqual({ time: 120, open: 11, high: 11, low: 11, close: 11, volume: 1 });
});

test("applyTick ignores late tick from a closed bucket", () => {
  const bar = applyTick(undefined, t(120, 10), 60);
  expect(applyTick(bar, t(100, 50), 60)).toBe(bar);
});
