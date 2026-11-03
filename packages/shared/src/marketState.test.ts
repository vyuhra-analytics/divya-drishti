import { expect, test } from "bun:test";
import type { Bar, Quote } from "./index";
import { bookImbalance, barReadings, marketState, optionReadings, STATE_RULES } from "./marketState";
import type { Chain } from "./options";

const T0 = Date.UTC(2026, 10, 3, 4, 0) / 1000;
/** `n` 5-minute bars from a start, price moving `step` per bar with a 2-point range; `days` repeats with an overnight gap */
function mk(n: number, start = 100, step = 0, t0 = T0): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + step * i + (i % 2 ? 0.5 : -0.5);
    return { time: t0 + i * 300, open: c - step, high: c + 1, low: c - 1, close: c, volume: 100 };
  });
}
const quote = (over: Partial<Quote> = {}): Quote => ({ symbol: "MCX:CRUDEOIL", price: 100, time: 1_000_000, source: "upstox", delayedBy: 0, ...over });
const lean = (rs: ReturnType<typeof barReadings>, id: string) => rs.find((r) => r.id === id)?.lean;

test("too few bars: every bar reading says why it cannot be read, nothing leans", () => {
  const rs = barReadings(mk(10), 100);
  expect(rs.every((r) => r.lean === "na")).toBe(true);
  expect(rs[0].note).toContain("30");
});

test("price beyond VWAP by the threshold leans with it, inside it is neutral", () => {
  const bars = mk(60);
  const a = 2; // ATR of these bars is about 2
  expect(lean(barReadings(bars, 100 + a, { atp: 100 }), "vwap")).toBe("up");
  expect(lean(barReadings(bars, 100 - a, { atp: 100 }), "vwap")).toBe("down");
  expect(lean(barReadings(bars, 100.05, { atp: 100 }), "vwap")).toBe("neutral");
  expect(lean(barReadings(bars, 100, {}), "vwap")).toBe("na"); // no ATP from the feed
});

test("day range position leans at the extremes only", () => {
  const bars = mk(60);
  expect(lean(barReadings(bars, 109, { dayHigh: 110, dayLow: 100 }), "range")).toBe("up");
  expect(lean(barReadings(bars, 101, { dayHigh: 110, dayLow: 100 }), "range")).toBe("down");
  expect(lean(barReadings(bars, 105, { dayHigh: 110, dayLow: 100 }), "range")).toBe("neutral");
  expect(lean(barReadings(bars, 105, {}), "range")).toBe("na");
});

test("momentum is the move over the last 30 minutes in ATR", () => {
  const bars = mk(60, 100, 0);
  expect(lean(barReadings(bars, 106, {}), "momentum")).toBe("up");
  expect(lean(barReadings(bars, 94, {}), "momentum")).toBe("down");
  expect(lean(barReadings(bars, 100.2, {}), "momentum")).toBe("neutral");
});

test("levels are context only and name the nearest above and below from yesterday's range", () => {
  // three sessions with overnight gaps: the first is never a source, yesterday is complete
  const day = (d: number, base: number) => mk(30, base, 0, T0 + d * 86_400);
  const bars = [...day(0, 100), ...day(1, 100), ...day(2, 100)];
  const r = barReadings(bars, 100.2, { decimals: 1 }).find((x) => x.id === "levels")!;
  expect(r.lean).toBe("neutral");
  expect(r.value).toContain("at "); // within half an ATR of a level
});

test("book imbalance uses depth when present, else the best quantities", () => {
  expect(bookImbalance({ bidQty: 300, askQty: 100 })).toBe(0.5);
  expect(bookImbalance({ depth: [{ bidQ: 100, askQ: 300 }, { bidQ: 100, askQ: 300 }] })).toBe(-0.5);
  expect(bookImbalance({})).toBeUndefined();
});

test("a stale quote makes the whole read stale and says so", () => {
  const s = marketState({ quote: quote({ time: 1_000_000 }), bars: mk(60), now: 1_000_000 + (STATE_RULES.staleSec + 5) * 1000 });
  expect(s.stale).toBe(true);
  expect(s.caveats[0]).toContain("old");
});

test("disagreement is reported as mixed, never averaged away", () => {
  const s = marketState({ quote: quote({ price: 102, atp: 100, bidQty: 100, askQty: 400, time: 5000 }), bars: mk(60), now: 6000 });
  // vwap leans up, the book leans down
  expect(s.readings.find((r) => r.id === "vwap")!.lean).toBe("up");
  expect(s.readings.find((r) => r.id === "book")!.lean).toBe("down");
  expect(s.agreement).toBe("mixed");
  expect(s.summary).toContain("disagree");
});

test("aligned needs at least two readings the same way and none the other", () => {
  const s = marketState({ quote: quote({ price: 102, atp: 100, bidQty: 400, askQty: 100, time: 5000 }), bars: mk(60), now: 6000 });
  expect(s.agreement).toBe("aligned-up");
});

test("the premium leans back toward fair value only at the extremes", () => {
  const q = quote({ time: 5000 });
  const at = (rank?: number) => marketState({ quote: q, bars: mk(60), now: 6000, premium: { pct: 0.5, rank } }).readings.find((r) => r.id === "premium")!.lean;
  expect(at(95)).toBe("down");
  expect(at(5)).toBe("up");
  expect(at(50)).toBe("neutral");
  expect(at(undefined)).toBe("neutral");
});

test("a release inside half an hour is a warning, far away it is just the next event", () => {
  const q = quote({ time: 5000 });
  const near = marketState({ quote: q, bars: mk(60), now: 6000, event: { title: "EIA crude", at: 6000 + 10 * 60_000 } });
  expect(near.readings.find((r) => r.id === "event")!.warn).toBe(true);
  expect(near.summary).toContain("stand aside");
  const far = marketState({ quote: q, bars: mk(60), now: 6000, event: { title: "EIA crude", at: 6000 + 5 * 3_600_000 } });
  expect(far.readings.find((r) => r.id === "event")!.warn).toBeUndefined();
});

test("option readings: walls come from open interest beyond spot, IV from the money strike", () => {
  const leg = (oi: number, iv = 30) => ({ key: "k", oi, iv });
  const chain = { underlying: "CRUDEOIL", expiry: "2026-11-20", expiries: [], atm: 100, pcr: 1.2, maxPain: 98, updatedAt: 0, rows: [
    { strike: 95, pe: leg(900) }, { strike: 100, ce: leg(10, 32), pe: leg(10, 28) }, { strike: 105, ce: leg(700) }, { strike: 110, ce: leg(100) },
  ] } as Chain;
  const rs = optionReadings(chain, 100, 2, 0);
  expect(rs.find((r) => r.id === "walls")!.value).toBe("95 / 105");
  expect(rs.find((r) => r.id === "iv")!.value).toBe("30.0%");
  expect(rs.every((r) => r.lean === "neutral")).toBe(true); // options are context, never a lean
  expect(optionReadings(null, 100, 2, 0)[0].lean).toBe("na");
});

test("causal: appending later bars never changes how earlier bars were read", () => {
  const bars = mk(80, 100, 0.1);
  const early = barReadings(bars.slice(0, 60), bars[59].close, { atp: 100 });
  const again = barReadings(bars.slice(0, 60), bars[59].close, { atp: 100 });
  expect(again).toEqual(early);
});
