import { expect, test } from "bun:test";
import { pivotLevels, sessionPivots, type PivotBar } from "./pivots";

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

test("classic pivots from H 110, L 90, C 100", () => {
  const l = pivotLevels(110, 90, 100);
  near(l.P, 100);
  near(l.R1, 110); // 2P - L
  near(l.S1, 90); // 2P - H
  near(l.R2, 120);
  near(l.S2, 80);
  near(l.R3, 130); // H + 2(P - L)
  near(l.S3, 70); // L - 2(H - P)
});

test("fibonacci and camarilla", () => {
  const f = pivotLevels(110, 90, 100, "fibonacci");
  near(f.R1, 100 + 0.382 * 20);
  near(f.S3, 80);
  const c = pivotLevels(110, 90, 100, "camarilla");
  near(c.R3, 100 + (1.1 * 20) / 4);
  near(c.S4, 100 - (1.1 * 20) / 2);
});

// three-bar sessions 5 minutes apart, 10 hours between sessions
const bar = (t: number, high: number, low: number, close: number): PivotBar => ({ time: t, high, low, close });
const session = (day: number, high: number, low: number, close: number): PivotBar[] => {
  const t0 = day * 86_400;
  return [bar(t0, high - 2, low + 2, high - 1), bar(t0 + 300, high, low, low + 1), bar(t0 + 600, high - 1, low + 1, close)];
};
const bars = [...session(1, 105, 95, 100), ...session(2, 110, 90, 104), ...session(3, 120, 100, 115), ...session(4, 118, 108, 112)];

test("a session's levels come from the previous session, the first session is never a source", () => {
  const p = sessionPivots(bars);
  expect(p).toHaveLength(2); // sessions 3 and 4; session 2 would rest on session 1, which may be half loaded
  expect(p[0].source).toEqual({ high: 110, low: 90, close: 104 });
  expect(p[0].from).toBe(3 * 86_400);
  expect(p[0].to).toBe(3 * 86_400 + 600);
  near(p[0].levels.P, (110 + 90 + 104) / 3);
  expect(p[1].source).toEqual({ high: 120, low: 100, close: 115 });
});

test("causal: later sessions never change an earlier session's levels", () => {
  const a = sessionPivots(bars.slice(0, 9));
  const b = sessionPivots(bars);
  expect(b[0]).toEqual(a[0]);
});

test("levels are the same on every candle of the session, and a one-session chart or daily chart has none", () => {
  expect(sessionPivots(session(1, 105, 95, 100))).toEqual([]);
  expect(sessionPivots([bar(0, 2, 1, 1.5), bar(86_400, 3, 2, 2.5), bar(172_800, 4, 3, 3.5)])).toEqual([]);
});
