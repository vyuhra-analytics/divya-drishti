import { expect, test } from "bun:test";
import { dayLevels } from "./dayLevels";

const T0 = Date.parse("2026-10-20T04:00:00Z") / 1000;
const DAY = 86_400;
// a day = 6 five-minute candles starting at T0 + n days; highs/lows differ per day
const day = (n: number, hi: number, lo: number) => Array.from({ length: 6 }, (_, i) => ({ time: T0 + n * DAY + i * 300, high: i === 2 ? hi : hi - 1, low: i === 3 ? lo : lo + 1 }));

test("today so far and the previous day, each starting at its own first candle; the first day loaded is not used", () => {
  const bars = [...day(0, 500, 400), ...day(1, 110, 90), ...day(2, 120, 95).slice(0, 4)];
  const d = dayLevels(bars)!;
  expect(d.previous).toEqual({ from: T0 + DAY, to: T0 + DAY + 6 * 300, high: 110, low: 90 });
  expect(d.today.from).toBe(T0 + 2 * DAY);
  expect(d.today.to).toBe(T0 + 2 * DAY + 4 * 300); // runs to the newest candle's end
  expect(d.today.high).toBe(120);
  expect(d.today.low).toBe(95);
});

test("a new high today moves today's level only; fewer than three days or daily candles give nothing", () => {
  const bars = [...day(0, 500, 400), ...day(1, 110, 90), ...day(2, 120, 95)];
  const more = [...bars, { time: bars[bars.length - 1].time + 300, high: 130, low: 100 }];
  expect(dayLevels(more)!.today.high).toBe(130);
  expect(dayLevels(more)!.previous.high).toBe(110);
  expect(dayLevels([...day(0, 500, 400), ...day(1, 110, 90)])).toBeUndefined();
  expect(dayLevels(Array.from({ length: 5 }, (_, i) => ({ time: T0 + i * DAY, high: 1, low: 0 })))).toBeUndefined();
});
