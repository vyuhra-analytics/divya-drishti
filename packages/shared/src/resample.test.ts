import { describe, expect, it } from "bun:test";
import { resampleBars } from "./resample";
import type { Bar } from "./index";

const m = (min: number, o: number, h: number, l: number, c: number, v: number, oi?: number): Bar => ({ time: min * 60, open: o, high: h, low: l, close: c, volume: v, ...(oi === undefined ? {} : { oi }) });

describe("resampleBars", () => {
  it("aggregates one-minute candles into five-minute buckets: first open, extremes, last close, summed volume, last OI", () => {
    const out = resampleBars([m(0, 10, 12, 9, 11, 5, 100), m(1, 11, 15, 10, 14, 3, 110), m(4, 14, 14, 8, 9, 2, 105), m(5, 9, 9, 9, 9, 1, 120)], 300);
    expect(out).toEqual([
      { time: 0, open: 10, high: 15, low: 8, close: 9, volume: 10, oi: 105 },
      { time: 300, open: 9, high: 9, low: 9, close: 9, volume: 1, oi: 120 },
    ]);
  });

  it("does not invent candles for minutes with no trade, keeps an absent OI absent, and leaves its input alone", () => {
    const input = [m(0, 1, 2, 1, 2, 1), m(3, 2, 3, 2, 3, 1)];
    const out = resampleBars(input, 300);
    expect(out).toHaveLength(1);
    expect(out[0].oi).toBeUndefined();
    expect(input[0].high).toBe(2);
    expect(input[0].volume).toBe(1);
  });

  it("puts the boundaries in the exchange's time when given its offset (IST is 19,800 s ahead of UTC)", () => {
    // 00:10 UTC = 05:40 IST: the hourly bucket starts at 05:00 IST = 23:30 UTC the day before
    const out = resampleBars([{ time: 600, open: 1, high: 1, low: 1, close: 1, volume: 1 }], 3600, 19_800);
    expect(out[0].time).toBe(-1800);
  });

  it("returns nothing for nothing", () => expect(resampleBars([], 300)).toEqual([]));
});
