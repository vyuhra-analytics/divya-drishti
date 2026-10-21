import { expect, test } from "bun:test";
import { agreement, DRIFT_FLAG_PCT } from "./drift";

const NOW = 1_800_000_000_000;
const at = (ageMs: number) => NOW - ageMs;

test("two live feeds a few ticks apart agree", () => {
  const a = agreement("MCX:CRUDEOIL", { upstox: { price: 9483, at: at(500) }, tradingview: { price: 9486, at: at(900) } }, NOW);
  expect(a.drifting).toBe(false);
  expect(a.sources.map((s) => s.source).sort()).toEqual(["tradingview", "upstox"]);
  expect(a.gap).toMatchObject({ points: 3, ticks: 3, between: ["upstox", "tradingview"] }); // crude ticks are 1 rupee
  expect(a.gap!.pct).toBeCloseTo((3 / 9483) * 100, 9);
});

test("a feed that has drifted far from the other is flagged", () => {
  const a = agreement("MCX:CRUDEOIL", { upstox: { price: 9483, at: at(1000) }, tradingview: { price: 9300, at: at(1000) } }, NOW); // wrong contract month, say
  expect(a.drifting).toBe(true);
  expect(a.gap!.pct).toBeGreaterThan(DRIFT_FLAG_PCT);
  expect(a.gap!.between).toEqual(["tradingview", "upstox"]);
});

test("a stale feed is left out, and fewer than two comparable feeds is no comparison", () => {
  const stale = agreement("MCX:CRUDEOIL", { upstox: { price: 9483, at: at(1000) }, tradingview: { price: 9000, at: at(5 * 60_000) } }, NOW);
  expect(stale.sources.map((s) => s.source)).toEqual(["upstox"]);
  expect(stale.gap).toBeUndefined();
  expect(stale.drifting).toBe(false);
  expect(agreement("MCX:CRUDEOIL", {}, NOW)).toEqual({ symbol: "MCX:CRUDEOIL", sources: [], drifting: false });
});

test("a delayed feed is not compared with a live one", () => {
  const a = agreement("NYMEX:CL", { tradingview: { price: 98.9, at: at(1000), delayedBy: 600 }, yahoo: { price: 98.95, at: at(1000), delayedBy: 600 }, upstox: { price: 120, at: at(1000), delayedBy: 0 } }, NOW);
  expect(a.sources.map((s) => s.source).sort()).toEqual(["tradingview", "yahoo"]); // the two delayed feeds are the larger comparable group
  expect(a.gap!.ticks).toBe(5); // NYMEX crude ticks are 0.01
  expect(a.drifting).toBe(false);
});

test("the flag threshold can be tightened or loosened by the caller", () => {
  const p = { upstox: { price: 9483, at: at(500) }, tradingview: { price: 9468, at: at(500) } }; // 0.158%
  expect(agreement("MCX:CRUDEOIL", p, NOW).drifting).toBe(true);
  expect(agreement("MCX:CRUDEOIL", p, NOW, 0.5).drifting).toBe(false);
  expect(agreement("MCX:CRUDEOIL", p, NOW, 0.01).drifting).toBe(true);
});
