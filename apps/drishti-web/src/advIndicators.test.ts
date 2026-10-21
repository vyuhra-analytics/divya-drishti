import { expect, test } from "bun:test";
import "openalgo-charts/indicators";
import { getIndicator, indicatorDefaults } from "openalgo-charts";
import { bollinger, macd, tzOffsetSec, vwap, type Bar, type Point } from "@drishti/shared";

// three MCX-like sessions (09:00 IST start, 5-minute bars) with overnight gaps
function sessions(): Bar[] {
  const out: Bar[] = [];
  let price = 9300;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 12;
  for (let d = 0; d < 3; d++) {
    const start = Date.UTC(2026, 9, 12 + d, 3, 30) / 1000; // 09:00 IST
    price += rnd() * 4; // overnight gap
    for (let i = 0; i < 120; i++) {
      const open = price;
      price = open + rnd();
      out.push({ time: start + i * 300, open, high: Math.max(open, price) + Math.abs(rnd()) / 3, low: Math.min(open, price) - Math.abs(rnd()) / 3, close: price, volume: 50 + Math.round(Math.abs(rnd()) * 20) });
    }
  }
  return out;
}
const bars = sessions();

function theirs(id: string, settings: Record<string, unknown> = {}) {
  const d: any = getIndicator(id);
  return d.calc(bars, { ...indicatorDefaults(d), ...settings }, {} as any) as Record<string, (number | null)[]>;
}
/** every point of ours must equal theirs at the same bar (theirs may also have later warm-up differences: reported) */
function compare(ours: Point[], theirsArr: (number | null)[], digits = 6) {
  let compared = 0;
  const bad: number[] = [];
  for (const p of ours) {
    const t = theirsArr[bars.findIndex((b) => b.time === p.time)];
    if (t === null || t === undefined || Number.isNaN(t)) {
      bad.push(p.time);
      continue;
    }
    expect(t).toBeCloseTo(p.value, digits);
    compared++;
  }
  return { compared, missing: bad.length };
}

test("MACD (12/26/9) converges to ours: it seeds its EMAs with an SMA, we seed like Pine's ta.ema, so only the first ~100 bars differ", () => {
  const t = theirs("macd");
  const o = macd(bars);
  const gap = (ours: Point[], theirsArr: (number | null)[]) =>
    ours.map((p) => Math.abs((theirsArr[bars.findIndex((b) => b.time === p.time)] ?? NaN) - p.value));
  const g = gap(o.macd, t.macd);
  expect(g[0]).toBeGreaterThan(1e-3); // different seeds: visibly different at the start
  expect(Math.max(...g.slice(-120))).toBeLessThan(0.05); // ...and the same where it matters (the recent bars)
  expect(Math.max(...gap(o.histogram, t.histogram).slice(-120))).toBeLessThan(0.05);
});

test("Bollinger Bands (20, 2σ) match", () => {
  const t = theirs("bollinger");
  const o = bollinger(bars, 20, 2);
  expect(compare(o.middle, t.basis).missing).toBe(0);
  expect(compare(o.upper, t.upper).missing).toBe(0);
  expect(compare(o.lower, t.lower).missing).toBe(0);
});

test("session VWAP matches and resets at each exchange day", () => {
  const t = theirs("vwap");
  const o = vwap(bars, (sec) => tzOffsetSec("Asia/Kolkata", sec * 1000));
  const r = compare(o, t.vwap);
  expect(r.missing).toBe(0);
  // the reset: the first bar of day 2 equals its own typical price
  const day2 = bars.findIndex((b) => b.time === Date.UTC(2026, 9, 13, 3, 30) / 1000);
  expect(t.vwap[day2]).toBeCloseTo((bars[day2].high + bars[day2].low + bars[day2].close) / 3, 6);
});
