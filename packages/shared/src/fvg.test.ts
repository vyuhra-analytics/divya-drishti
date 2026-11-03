import { expect, test } from "bun:test";
import { findFvgs, type FvgBar } from "./fvg";

const b = (i: number, low: number, high: number, close = (low + high) / 2): FvgBar => ({ time: i * 60, open: close, high, low, close });

// bar 2's low (105) is above bar 0's high (102): a bullish gap 102..105 with the middle candle at index 1
const up = [b(0, 100, 102), b(1, 102, 108), b(2, 105, 110)];

test("a bullish gap is found when the third candle closes, and starts at the middle candle", () => {
  expect(findFvgs(up)).toEqual([{ dir: "bull", top: 105, bottom: 102, start: 1, formed: 2 }]);
});

test("a bearish gap mirrors it", () => {
  const down = [b(0, 108, 110), b(1, 100, 108), b(2, 95, 105)];
  expect(findFvgs(down)).toEqual([{ dir: "bear", top: 108, bottom: 105, start: 1, formed: 2 }]);
});

test("overlapping candles leave no gap", () => {
  expect(findFvgs([b(0, 100, 102), b(1, 101, 106), b(2, 102, 108)])).toEqual([]);
});

test("mitigation modes: touch, midpoint, full", () => {
  const next = [...up, b(3, 106, 111), b(4, 104, 109), b(5, 103, 108), b(6, 101, 106)];
  expect(findFvgs(next, { mitigation: "touch" })[0].mitigated).toBe(4); // low 104 <= top 105
  expect(findFvgs(next, { mitigation: "mid" })[0].mitigated).toBe(5); // low 103 <= 103.5
  expect(findFvgs(next, { mitigation: "full" })[0].mitigated).toBe(6); // low 101 <= 102
  expect(findFvgs(up)[0].mitigated).toBeUndefined();
});

test("minimum size filters small gaps by ATR", () => {
  expect(findFvgs(up, { minSizeAtr: 0.1 })).toHaveLength(1);
  expect(findFvgs(up, { minSizeAtr: 5 })).toHaveLength(0);
});

test("causal: appending bars never changes a gap's shape, only its mitigation", () => {
  const more = [...up, b(3, 106, 111), b(4, 107, 112)];
  const a = findFvgs(up)[0];
  const c = findFvgs(more)[0];
  expect({ ...c, mitigated: undefined }).toEqual({ ...a, mitigated: undefined });
});
