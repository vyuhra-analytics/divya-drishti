import { describe, expect, it } from "bun:test";
import { buildObservations, entryIndex, holm, icTest, lookAheadShift, ranks, rng, shuffledControl, spearman, type HBar, type Headline } from "./sentimentStudy";

const HOUR = 3_600_000;
const t0 = Date.UTC(2026, 5, 1, 0, 0); // a Monday
const bars = (n: number, closeOf: (i: number) => number): HBar[] =>
  Array.from({ length: n }, (_, i) => ({ time: (t0 + i * HOUR) / 1000, open: i === 0 ? 100 : closeOf(i - 1), close: closeOf(i) }));

describe("which bar an event enters on", () => {
  const b = bars(10, () => 100);
  it("is the first bar that starts at least 60 seconds after the event, never the bar holding it", () => {
    expect(entryIndex(b, t0 + 30 * 60_000)).toBe(1); // inside bar 0: trade from bar 1
    expect(entryIndex(b, t0 + HOUR - 60_000)).toBe(1); // exactly 60 s before the next open: allowed
    expect(entryIndex(b, t0 + HOUR - 59_000)).toBe(2); // 59 s: too late for that bar
    expect(entryIndex(b, t0 - 5 * HOUR)).toBe(0);
    expect(entryIndex(b, t0 + 20 * HOUR)).toBe(-1); // no bar left
  });
});

describe("ranks, Spearman, Holm", () => {
  it("gives tied values the mean rank", () => expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]));

  it("is 1 for a monotone pair, -1 for a reversed one and 0 for a constant", () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 10);
    expect(spearman([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });

  it("Holm raises the smallest p by the number of tests and never lets an adjusted p fall below an earlier one", () => {
    expect(holm([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(holm([0.5])).toEqual([0.5]);
    expect(holm([0.6, 0.9]).every((x) => x <= 1)).toBe(true);
  });
});

describe("observations", () => {
  const closes = (i: number) => 100 + i * 0.1;
  const b = bars(60, closes);
  const tone = (t: string) => (t.startsWith("up") ? 0.8 : t.startsWith("down") ? -0.8 : 0);

  it("one observation per entry bar with the mean tone of its events and the returns from that bar's open", () => {
    const h: Headline[] = [
      { at: t0 + 10 * 60_000, title: "up a" },
      { at: t0 + 20 * 60_000, title: "down b" },
      { at: t0 + 3 * HOUR + 5 * 60_000, title: "up c" },
    ];
    const o = buildObservations(h, b, { tone, expiries: [] });
    expect(o).toHaveLength(2);
    expect(o[0]).toMatchObject({ entry: t0 + HOUR, events: 2, tone: 0 });
    expect(o[0].r60).toBeCloseTo(b[1].close / b[1].open - 1, 12);
    expect(o[1].entry).toBe(t0 + 4 * HOUR);
    expect(o[1].r1d).toBeCloseTo(b[27].close / b[4].open - 1, 12); // last bar starting before entry + 24 h is bar 27
  });

  it("drops an observation whose window touches a contract roll", () => {
    const h: Headline[] = [{ at: t0 + 10 * 60_000, title: "up a" }, { at: t0 + 30 * HOUR, title: "up b" }];
    const expiry = Date.UTC(2026, 5, 2); // inside the first window
    const o = buildObservations(h, b, { tone, expiries: [expiry] });
    expect(o.every((x) => Math.abs(x.entry - expiry) > 2 * 24 * HOUR || x.entry > expiry + 3 * 24 * HOUR)).toBe(true);
    expect(o.length).toBeLessThan(2);
  });

  it("has no 1-day return when the market was shut for most of the day", () => {
    const sparse = b.slice(0, 5); // only five bars exist: no bar near entry + 24 h
    const o = buildObservations([{ at: t0 + 10 * 60_000, title: "up a" }], sparse, { tone, expiries: [] });
    expect(o[0].r1d).toBeUndefined();
  });
});

describe("the IC test and the controls", () => {
  const rand = rng(42);
  const n = 400;
  const tone = Array.from({ length: n }, () => rand() * 2 - 1);
  const noise = () => (rand() - 0.5) * 0.02;

  it("finds a planted relation: tone that really predicts the return gives a high IC and a tiny p", () => {
    const ret = tone.map((x) => x * 0.01 + noise());
    const r = icTest(tone, ret, 2000);
    expect(r.ic).toBeGreaterThan(0.3);
    expect(r.p).toBeLessThan(0.01);
  });

  it("finds nothing in noise: unrelated tone gives an IC near zero and no small p", () => {
    const ret = tone.map(() => noise());
    const r = icTest(tone, ret, 2000);
    expect(Math.abs(r.ic)).toBeLessThan(0.15);
    expect(r.p).toBeGreaterThan(0.01);
  });

  it("the shuffled control sits near zero even on data where tone does predict", () => {
    const ret = tone.map((x) => x * 0.01 + noise());
    expect(Math.abs(shuffledControl(tone, ret).z)).toBeLessThan(3);
  });

  it("gives the same answer twice (seeded) and does not call a tiny sample", () => {
    const ret = tone.map((x) => x * 0.01 + noise());
    expect(icTest(tone, ret, 500, 3).p).toBe(icTest(tone, ret, 500, 3).p);
    expect(icTest([1, 2, 3], [1, 2, 3]).p).toBe(1);
  });
});

describe("the look-ahead test", () => {
  it("moving every event an hour later changes the bar, and so the return, each event is assigned", () => {
    const b = bars(80, (i) => 100 + Math.sin(i) * 2);
    const h: Headline[] = Array.from({ length: 30 }, (_, i) => ({ at: t0 + (i + 1) * HOUR + 10 * 60_000, title: "up" }));
    expect(lookAheadShift(h, b)).toBe(1);
  });

  it("is zero for a pipeline that ignores time: events past the last bar and an empty list", () => {
    const b = bars(5, () => 100);
    expect(lookAheadShift([{ at: t0 + 40 * HOUR, title: "x" }], b)).toBe(0);
    expect(lookAheadShift([], b)).toBe(0);
  });
});
