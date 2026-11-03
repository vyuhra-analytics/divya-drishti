import { expect, test } from "bun:test";
import { correlation, dir, movePct, priceAt, signedStats } from "./eia-cfd-drift";

const AT = Date.parse("2019-03-13T14:30:00Z") / 1000;
const bar = (min: number, open: number, volume = 1) => ({ time: AT + min * 60, open, high: open, low: open, close: open, volume });

test("price is the open of the first traded bar at or after the minute; untraded bars are skipped", () => {
  const bars = [bar(1, 70, 0), bar(2, 71), bar(30, 72)];
  expect(priceAt(bars, AT, 1)).toBe(71);
  expect(priceAt(bars, AT, 10)).toBeUndefined(); // nothing within 5 minutes
  expect(movePct(bars, AT, 1, 30)).toBeCloseTo(((72 - 71) / 71) * 100);
});

test("a draw below the forecast is up, a build is down", () => {
  expect(dir(-4)).toBe(1);
  expect(dir(4)).toBe(-1);
  expect(dir(0)).toBe(0);
});

test("signed test finds a real link and not a random one", () => {
  // price always moves against the surprise's sign by 1% -> signed mean +1, tiny p
  const real = Array.from({ length: 40 }, (_, i) => ({ surprise: i % 2 ? -4 : 4, move: i % 2 ? 1 : -1 }));
  const s = signedStats(real)!;
  expect(s.mean).toBeCloseTo(1);
  expect(s.p).toBeLessThan(0.01);
  // moves unrelated to the surprise's sign -> mean near 0, large p
  const noise = Array.from({ length: 40 }, (_, i) => ({ surprise: i % 2 ? -4 : 4, move: i % 4 < 2 ? 1 : -1 }));
  expect(Math.abs(signedStats(noise)!.mean)).toBeLessThan(0.1);
  expect(signedStats(noise)!.p).toBeGreaterThan(0.1);
});

test("correlation: perfect line gives r 1 and tiny p; needs 5 days", () => {
  const line = Array.from({ length: 20 }, (_, i) => ({ surprise: i - 10, move: -(i - 10) * 0.1 }));
  const c = correlation(line)!;
  expect(c.r).toBeCloseTo(-1);
  expect(c.p).toBeLessThan(0.01);
  expect(correlation(line.slice(0, 3))).toBeUndefined();
});
