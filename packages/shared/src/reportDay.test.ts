import { describe, expect, it } from "bun:test";
import { dayStage, nearestWalls, preReleaseRange, readiness, suggestStrike, watchWindow, type DayBar } from "./reportDay";
import type { Chain, OptionLeg } from "./options";

const REL = 1_793_000_000 - (1_793_000_000 % 300); // a 5-minute boundary, epoch seconds
const RELMS = REL * 1000;
const bar = (time: number, o: number, h: number, l: number, c: number): DayBar => ({ time, open: o, high: h, low: l, close: c });

describe("dayStage", () => {
  it("prep until the range hour, range for the hour, print for two minutes, the window to the 30-minute cut-off, then after", () => {
    const at = (min: number) => dayStage(RELMS + min * 60_000, RELMS);
    expect(at(-300)).toBe("prep");
    expect(at(-61)).toBe("prep");
    expect(at(-60)).toBe("range");
    expect(at(-1)).toBe("range");
    expect(at(0)).toBe("print");
    expect(at(1.9)).toBe("print");
    expect(at(2)).toBe("window");
    expect(at(29.9)).toBe("window");
    expect(at(30)).toBe("after");
    expect(dayStage(RELMS + 45 * 60_000, RELMS, 60)).toBe("window");
  });
});

/** the hour before the print: twelve 5-minute candles between 100 and 110, a flat close of 105 */
const hour = () => Array.from({ length: 12 }, (_, i) => bar(REL - 3600 + i * 300, 105, i === 4 ? 110 : 107, i === 7 ? 100 : 103, 105));

describe("preReleaseRange", () => {
  it("is the high and low of the hour before the print, and complete once the print has come", () => {
    const r = preReleaseRange(hour(), REL, REL + 10)!;
    expect(r).toMatchObject({ high: 110, low: 100, width: 10, candles: 12, complete: true });
  });

  it("while the hour runs it covers what has opened so far, and is not complete", () => {
    const r = preReleaseRange(hour(), REL, REL - 1800)!;
    expect(r.candles).toBe(7); // the candles that have opened by half an hour before the print... 12 - 6 + 1
    expect(r.complete).toBe(false);
  });

  it("ignores candles outside the hour and says nothing without any", () => {
    expect(preReleaseRange([bar(REL - 7200, 1, 999, 0, 1), bar(REL + 300, 1, 999, 0, 1)], REL, REL + 600)).toBeUndefined();
  });
});

describe("watchWindow", () => {
  const range = { high: 110, low: 100, width: 10, candles: 12, complete: true };
  /** twenty quiet candles before (true range 2 each), then the window */
  const before = Array.from({ length: 20 }, (_, i) => bar(REL - 6000 + i * 300, 100, 101, 99, 100));
  const win = (closes: number[], opens?: number[]) => closes.map((c, i) => bar(REL + i * 300, opens?.[i] ?? c, Math.max(c, opens?.[i] ?? c) + 0.5, Math.min(c, opens?.[i] ?? c) - 0.5, c));

  it("marks each closed candle inside / above / below and signals on the first close beyond the range, with R from the ATR and the levels from the next open", () => {
    const bars = [...before, ...win([105, 111, 112], [105, 105, 111.5])];
    const w = watchWindow(bars, REL, range, undefined, REL + 15 * 60);
    expect(w.candles.map((c) => c.state)).toEqual(["inside", "above", "above"]);
    expect(w.signal).toMatchObject({ side: "long", candleTime: REL + 300, closedAt: REL + 600, entry: 111.5 });
    // the last 14 true ranges up to and including the signal candle: twelve quiet ones of 2, then 5.5 (the first window candle) and 7 (the signal candle)
    const atr = (12 * 2 + 5.5 + 7) / 14;
    expect(w.signal!.atr).toBeCloseTo(atr, 9);
    expect(w.signal!.rPoints).toBeCloseTo(1.5 * atr, 9);
    expect(w.signal!.stop).toBeCloseTo(111.5 - 1.5 * atr, 9);
    expect(w.signal!.tp1).toBeCloseTo(111.5 + 1.5 * atr, 9);
    expect(w.signal!.tp2).toBeCloseTo(111.5 + 3 * atr, 9);
  });

  it("with a surprise side only a break on that side is an entry; the other way is marked and skipped", () => {
    const bars = [...before, ...win([105, 111, 108, 98, 97])]; // breaks up, then down
    const long = watchWindow(bars, REL, range, "long", REL + 25 * 60);
    expect(long.signal?.side).toBe("long");
    const short = watchWindow(bars, REL, range, "short", REL + 25 * 60);
    expect(short.candles[1]).toMatchObject({ state: "above", against: true });
    expect(short.skippedAgainst).toBe(1);
    expect(short.signal).toMatchObject({ side: "short", candleTime: REL + 900 }); // the later close below
  });

  it("a candle that is still forming never signals, and a break after the cut-off is no entry", () => {
    const forming = watchWindow([...before, ...win([105, 111])], REL, range, undefined, REL + 300 + 120);
    expect(forming.candles[1].complete).toBe(false);
    expect(forming.signal).toBeUndefined();
    const late = [...before, ...win([105, 105, 105, 105, 105, 105, 112])]; // the break closes at +35 minutes
    const w = watchWindow(late, REL, range, undefined, REL + 40 * 60);
    expect(w.signal).toBeUndefined();
    expect(w.cutoffReached).toBe(true);
    expect(w.candles).toHaveLength(6); // candles from the cut-off on are not part of the window
  });

  it("has no entry price until the candle after the signal exists", () => {
    const w = watchWindow([...before, ...win([105, 111])], REL, range, undefined, REL + 600);
    expect(w.signal).toMatchObject({ side: "long" });
    expect(w.signal!.entry).toBeUndefined();
    expect(w.signal!.stop).toBeUndefined();
  });

  it("is causal: a candle after the signal never changes it", () => {
    const base = [...before, ...win([105, 111, 112], [105, 105, 111.5])];
    const a = watchWindow(base, REL, range, undefined, REL + 15 * 60);
    const b = watchWindow([...base, bar(REL + 900, 1, 500, 0, 1)], REL, range, undefined, REL + 20 * 60);
    expect(b.signal).toEqual(a.signal);
  });
});

describe("suggestStrike", () => {
  const leg = (delta: number, ask: number, over: Partial<OptionLeg> = {}): OptionLeg => ({ key: "k", ask, ltp: ask, delta, theta: -5, iv: 40, oi: 1000, volume: 50, ...over });
  const chain = (calls: [number, number, number][], over: Partial<Chain> = {}): Chain => ({
    underlying: "CRUDEOIL",
    expiry: "2026-11-17",
    expiries: [],
    atm: 9600,
    lot: 100,
    updatedAt: 0,
    rows: calls.map(([strike, delta, ask]) => ({ strike, ce: leg(delta, ask), pe: leg(-delta, ask) })),
    ...over,
  });
  // strike, |delta|, premium per unit; one lot = 100 units
  const base = chain([[9500, 0.62, 240], [9550, 0.57, 200], [9600, 0.52, 170], [9650, 0.46, 140], [9700, 0.4, 110]]);

  it("takes the at-the-money strike when its delta is at least 0.5, as a call for a long and a put for a short", () => {
    const long = suggestStrike(base, "long");
    expect(long.pick).toMatchObject({ strike: 9600, side: "long", premium: 170, cost: 17_000, delta: 0.52 });
    expect(suggestStrike(base, "short").pick?.side).toBe("short");
    expect(long.rows.map((r) => r.strike)).toEqual([9500, 9550, 9600, 9650, 9700]);
    expect(long.rows.find((r) => r.atm)?.strike).toBe(9600);
  });

  it("under 0.5 at the money, takes the strike nearest 0.6 delta among those at or over 0.5, if it fits the capital", () => {
    const low = chain([[9500, 0.64, 240], [9550, 0.58, 200], [9600, 0.48, 170], [9650, 0.4, 140]]);
    expect(suggestStrike(low, "long").pick?.strike).toBe(9550); // 0.58 is nearer 0.6 than 0.64
    const dear = chain([[9500, 0.64, 900], [9550, 0.58, 800], [9600, 0.48, 170]]); // the 0.6 strikes cost 80,000+ per lot, over 70,000
    expect(suggestStrike(dear, "long").pick?.strike).toBe(9600);
  });

  it("checks the loss cap once R is known: a lower-delta strike when 1R is over it, no trade when none fits", () => {
    // R = 40 points: 40 x 0.52 x 100 = 2,080 over the 2,000 cap; the 0.46 strike gives 1,840
    const s = suggestStrike(base, "long", 40);
    expect(s.pick).toMatchObject({ strike: 9650, delta: 0.46 });
    expect(s.pick!.rupeeR).toBeCloseTo(1840, 6);
    expect(s.note).toContain("lower-delta");
    const none = suggestStrike(base, "long", 100); // 100 x 0.4 x 100 = 4,000 even on the lowest delta
    expect(none.pick).toBeUndefined();
    expect(none.note).toContain("No trade");
    expect(suggestStrike(base, "long", 10).pick?.strike).toBe(9600); // 520 rupees: fits
  });

  it("says why there is no pick: no chain, no side yet, nothing that fits the capital", () => {
    expect(suggestStrike(null, "long").pick).toBeUndefined();
    expect(suggestStrike(base, undefined).note).toContain("No side yet");
    const dear = chain([[9600, 0.52, 900]]);
    expect(suggestStrike(dear, "long").note).toContain("fits");
  });
});

describe("readiness", () => {
  const good = { now: RELMS - 3600_000, releaseAt: RELMS, forecast: { source: "Forex Factory" }, lastCandle: REL - 3600 - 120, chainAgeMs: 2000, chainPriced: 9, reportReachable: true };

  it("everything ready: five ticks, each with its plain answer", () => {
    const r = readiness(good);
    expect(r.map((x) => x.id)).toEqual(["release", "forecast", "candles", "chain", "number"]);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(r[1].detail).toBe("Forex Factory");
  });

  it("says what is wrong: no forecast, old candles, a chain without greeks or stale, a silent source", () => {
    expect(readiness({ ...good, forecast: undefined })[1]).toMatchObject({ ok: false });
    expect(readiness({ ...good, forecast: undefined })[1].detail).toContain("type the number");
    const old = readiness({ ...good, lastCandle: REL - 3600 - 3600 })[2];
    expect(old.ok).toBe(false);
    expect(old.detail).toContain("is MCX open");
    expect(readiness({ ...good, chainPriced: 1 })[3]).toMatchObject({ ok: false, detail: "too few strikes with a price and a delta" });
    expect(readiness({ ...good, chainAgeMs: 60_000 })[3].ok).toBe(false);
    expect(readiness({ ...good, reportReachable: false })[4].ok).toBe(false);
    expect(readiness({ ...good, reportReachable: undefined })[4].detail).toBe("checking");
    expect(readiness({ ...good, releaseAt: undefined })[0].ok).toBe(false);
  });
});

describe("nearestWalls", () => {
  const leg = (oi: number): OptionLeg => ({ key: "k", oi });
  const ch = (rows: [number, number, number][]): Chain => ({ underlying: "CRUDEOIL", expiry: "x", expiries: [], spot: 9620, updatedAt: 0, rows: rows.map(([strike, ce, pe]) => ({ strike, ce: leg(ce), pe: leg(pe) })) });

  it("the biggest call open interest at or above the price and the biggest put open interest at or below it", () => {
    const w = nearestWalls(ch([[9500, 10, 7000], [9550, 20, 3000], [9600, 30, 5000], [9650, 4000, 40], [9700, 9000, 50], [9750, 100, 60]]), 9620);
    expect(w.call).toEqual({ strike: 9700, oi: 9000 }); // 9650 has 4,000 but 9700 has more, and 9600 is below the price
    expect(w.put).toEqual({ strike: 9500, oi: 7000 });
  });

  it("falls back to the chain's spot, and says nothing without a price or open interest", () => {
    expect(nearestWalls(ch([[9650, 5, 0], [9600, 0, 9]]), undefined).call?.strike).toBe(9650);
    expect(nearestWalls(null, 100)).toEqual({});
    expect(nearestWalls({ ...ch([[9650, 0, 0]]), spot: undefined }, undefined)).toEqual({});
    expect(nearestWalls(ch([[9650, 0, 0]]), 9620).call).toBeUndefined();
  });
});
