import { expect, test } from "bun:test";
import { adjustBackward, changedFronts } from "./continuous";
import type { Bar } from "./index";

const bar = (time: number, p: number): Bar => ({ time, open: p, high: p + 1, low: p - 1, close: p, volume: 10 }) as Bar;

test("adjustBackward shifts only bars before each roll, newest contract untouched", () => {
  const bars = [bar(100, 90), bar(200, 92), bar(300, 100), bar(400, 101)]; // jump 92 → 100 at the roll at t=250
  const out = adjustBackward(bars, [{ at: 250, gap: 8 }]);
  expect(out.map((b) => b.close)).toEqual([98, 100, 100, 101]);
  expect(out[0]).toMatchObject({ open: 98, high: 99, low: 97, volume: 10 });
  expect(bars[0].close).toBe(90); // input not mutated
});

test("adjustBackward accumulates gaps across several rolls", () => {
  const bars = [bar(100, 80), bar(300, 90), bar(500, 100)];
  const out = adjustBackward(bars, [{ at: 400, gap: 4 }, { at: 200, gap: 6 }]);
  expect(out.map((b) => b.close)).toEqual([90, 94, 100]); // oldest: +6+4, middle: +4
  expect(adjustBackward(bars, [])).toBe(bars);
});

test("changedFronts ignores first sightings and unchanged contracts", () => {
  const prev = new Map([["CRUDEOIL", "A"], ["NATURALGAS", "B"]]);
  const next = new Map([["CRUDEOIL", "A2"], ["NATURALGAS", "B"], ["CRUDEOILM", "C"]]);
  expect(changedFronts(prev, next)).toEqual([{ underlying: "CRUDEOIL", from: "A", to: "A2" }]);
});
