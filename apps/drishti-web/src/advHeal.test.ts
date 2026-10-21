import { expect, test } from "bun:test";
import { healedRange } from "./AdvancedChart";

test("a view that shows the latest bars is left alone", () => {
  expect(healedRange({ from: 116, to: 179 }, 176)).toBeNull();
  expect(healedRange({ from: 100, to: 176 }, 176)).toBeNull();
  expect(healedRange(null, 176)).toBeNull();
  expect(healedRange({ from: 0, to: 10 }, 1)).toBeNull(); // nothing loaded yet
});

test("a view pointing past the loaded bars, or stuck at the first few, is moved to the latest ~60", () => {
  expect(healedRange({ from: 3562, to: 3617 }, 176)).toEqual({ from: 116, to: 179 }); // history-sized viewport on a 176-bar window
  expect(healedRange({ from: -60, to: 3 }, 461)).toEqual({ from: 401, to: 464 }); // the first bars only
  expect(healedRange({ from: 0, to: 50 }, 40)).toBeNull(); // the data is short: showing it all is fine
});
