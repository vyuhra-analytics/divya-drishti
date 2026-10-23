import { describe, expect, it } from "bun:test";
import { computeDrivers, DRIVER_PAIRS, premiumSeries, premiumStats } from "./drivers";
import type { Bar, Quote } from "./index";

const q = (symbol: string, price: number, prevClose?: number, delayedBy = 0): Quote => ({ symbol, price, prevClose, time: 1_000, source: "upstox", delayedBy }) as Quote;
const bar = (time: number, close: number): Bar => ({ time, open: close, high: close, low: close, close, volume: 0 });

describe("computeDrivers", () => {
  it("fair value is the NYMEX price times USD/INR and the premium is MCX against it (live figures of 2026-10-23)", () => {
    const d = computeDrivers(q("MCX:CRUDEOIL", 9549), q("NYMEX:CL", 100.29, undefined, 600), q("FX:USDINR", 94.87));
    expect(d.fair).toBeCloseTo(9514.6, 0);
    expect(d.premium).toBeCloseTo(34.4, 0);
    expect(d.premiumPct).toBeCloseTo(0.36, 2);
    expect(d.global!.delayMin).toBe(10); // the free NYMEX feed runs 10 minutes behind
    expect(d.mcx!.delayMin).toBe(0);
  });

  it("splits the day move into the NYMEX part, the rupee part and the premium change, and the parts add up to the total", () => {
    const d = computeDrivers(q("MCX:CRUDEOIL", 9600, 9500), q("NYMEX:CL", 101, 100), q("FX:USDINR", 95.2, 95));
    const s = d.split!;
    expect(s.total).toBeCloseTo(1.047, 2);
    expect(s.global).toBeCloseTo(0.995, 2);
    expect(s.fx).toBeCloseTo(0.21, 2);
    expect(s.global + s.fx + s.premium).toBeCloseTo(s.total, 2);
    expect(s.premium).toBeCloseTo(-0.158, 2);
  });

  it("gives no split without all three previous closes, and nothing at all for a leg that is missing", () => {
    expect(computeDrivers(q("MCX:CRUDEOIL", 9600, 9500), q("NYMEX:CL", 101), q("FX:USDINR", 95.2, 95)).split).toBeUndefined();
    const d = computeDrivers(q("MCX:CRUDEOIL", 9600, 9500), undefined, q("FX:USDINR", 95.2, 95));
    expect([d.fair, d.premium, d.split]).toEqual([undefined, undefined, undefined]);
    expect(computeDrivers(q("MCX:CRUDEOIL", 0), q("NYMEX:CL", 100), q("FX:USDINR", 95)).mcx).toBeUndefined(); // a zero price is no price
  });

  it("maps the four MCX energy futures to the NYMEX contract they follow", () => {
    expect(DRIVER_PAIRS["MCX:CRUDEOILM"]).toBe("NYMEX:CL");
    expect(DRIVER_PAIRS["MCX:NATGASMINI"]).toBe("NYMEX:NG");
  });
});

describe("premium history", () => {
  const times = Array.from({ length: 40 }, (_, i) => 1_000 + i * 300);

  it("joins the three instruments on bar time and skips a bar any of them lacks", () => {
    const mcx = times.map((t) => bar(t, 9500));
    const global = times.filter((t) => t !== times[3]).map((t) => bar(t, 100));
    const fx = times.map((t) => bar(t, 95));
    const s = premiumSeries(mcx, global, fx);
    expect(s).toHaveLength(39);
    expect(s[0].premium).toBeCloseTo(0, 6); // 100 x 95 = 9500
    expect(premiumSeries(mcx, global, fx.map((b) => ({ ...b, close: 0 })))).toEqual([]);
  });

  it("ranks the current premium inside its own range, and says nothing on a short history", () => {
    const mcx = times.map((t, i) => bar(t, 9500 + i)); // premium rises 0..39 rupees
    const series = premiumSeries(mcx, times.map((t) => bar(t, 100)), times.map((t) => bar(t, 95)));
    const stats = premiumStats(series, series[30].premiumPct)!;
    expect(stats.n).toBe(40);
    expect(stats.rank).toBe(75); // 30 of 40 are lower
    expect(stats.min).toBeLessThan(stats.median);
    expect(stats.median).toBeLessThan(stats.max);
    expect(premiumStats(series.slice(0, 10), 0)).toBeUndefined();
  });
});
