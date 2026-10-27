import { describe, expect, it } from "bun:test";
import { po3Outcome, po3Stats, po3Sweeps } from "./po3";
import type { ZoneBar } from "./sessionZones";

const edt = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 + 4 * 3600;
const bar = (time: number, o: number, h: number, l: number, c: number): ZoneBar => ({ time, open: o, high: h, low: l, close: c });
/** a flat 5-minute bar at `p` */
const flat = (time: number, p: number): ZoneBar => bar(time, p, p + 0.2, p - 0.2, p);

/** the evening before (20:00 to 24:00, range 100 to 110) then a quiet night until `until`, as 5-minute bars */
function night(day: string, prev: string, until: string): ZoneBar[] {
  const out: ZoneBar[] = [];
  for (let i = 0; i < 48; i++) out.push(i % 2 ? bar(edt(prev, "20:00") + i * 300, 105, 110, 100, 105) : flat(edt(prev, "20:00") + i * 300, 105)); // range 100..110
  const end = edt(day, until);
  for (let t = edt(day, "00:00"); t < end; t += 300) out.push(flat(t, 105));
  return out;
}
const at = (day: string, hhmm: string) => edt(day, hhmm);
const replaceAt = (bars: ZoneBar[], t: number, b: ZoneBar) => {
  const i = bars.findIndex((x) => x.time === t);
  if (i < 0) throw new Error("no bar at " + t);
  bars[i] = b;
};

describe("po3Sweeps", () => {
  it("a London bar that takes out the Asian high and a bar that closes back inside is a bearish setup, marked on the confirming bar", () => {
    const bars = night("2026-10-21", "2026-10-20", "06:00");
    replaceAt(bars, at("2026-10-21", "03:00"), bar(at("2026-10-21", "03:00"), 108, 112, 107, 111)); // sweeps 110, closes above it
    replaceAt(bars, at("2026-10-21", "03:05"), bar(at("2026-10-21", "03:05"), 111, 111.5, 108, 108.5)); // closes back inside
    const [e] = po3Sweeps(bars);
    expect(e).toMatchObject({ day: "2026-10-21", bias: "bearish", side: "high", sweepAt: at("2026-10-21", "03:00"), confirmAt: at("2026-10-21", "03:05"), rangeHigh: 110 });
    expect(e.extreme).toBe(112);
    expect(po3Sweeps(bars)).toHaveLength(1);
  });

  it("a wick that closes back inside on the same bar confirms at once; a swept low is the bullish one", () => {
    const bars = night("2026-10-21", "2026-10-20", "06:00");
    replaceAt(bars, at("2026-10-21", "02:30"), bar(at("2026-10-21", "02:30"), 101, 102, 97, 101)); // low 97 under 100, closes inside
    const [e] = po3Sweeps(bars);
    expect(e).toMatchObject({ bias: "bullish", side: "low", sweepAt: at("2026-10-21", "02:30"), confirmAt: at("2026-10-21", "02:30") });
  });

  it("a breakout that never closes back inside, a bar through both sides, and a sweep outside the London window are not events", () => {
    const breakout = night("2026-10-21", "2026-10-20", "06:00");
    for (let t = at("2026-10-21", "03:00"); t < at("2026-10-21", "04:30"); t += 300) replaceAt(breakout, t, bar(t, 112, 113, 111, 112));
    expect(po3Sweeps(breakout)).toHaveLength(0);

    const both = night("2026-10-21", "2026-10-20", "06:00");
    replaceAt(both, at("2026-10-21", "03:00"), bar(at("2026-10-21", "03:00"), 105, 115, 95, 105));
    expect(po3Sweeps(both)).toHaveLength(0);

    const late = night("2026-10-21", "2026-10-20", "09:00");
    replaceAt(late, at("2026-10-21", "06:00"), bar(at("2026-10-21", "06:00"), 108, 112, 107, 109));
    expect(po3Sweeps(late)).toHaveLength(0);
  });

  it("the other side going too before a close back inside is a breakout, not a sweep", () => {
    const bars = night("2026-10-21", "2026-10-20", "06:00");
    replaceAt(bars, at("2026-10-21", "03:00"), bar(at("2026-10-21", "03:00"), 108, 112, 107, 111));
    replaceAt(bars, at("2026-10-21", "03:05"), bar(at("2026-10-21", "03:05"), 111, 112, 95, 111));
    expect(po3Sweeps(bars)).toHaveLength(0);
  });

  it("without an Asian range (an MCX-like chart) there is nothing to sweep", () => {
    const bars: ZoneBar[] = [];
    for (let t = at("2026-10-21", "02:00"); t < at("2026-10-21", "06:00"); t += 300) bars.push(bar(t, 100, 130, 70, 100));
    expect(po3Sweeps(bars)).toEqual([]);
  });

  it("is causal: bars after the confirmation never change an event already found", () => {
    const base = night("2026-10-21", "2026-10-20", "04:00");
    replaceAt(base, at("2026-10-21", "03:00"), bar(at("2026-10-21", "03:00"), 108, 112, 107, 109));
    const more = [...base];
    for (let t = at("2026-10-21", "04:00"); t < at("2026-10-21", "10:00"); t += 300) more.push(bar(t, 50, 300, 1, 50));
    expect(po3Sweeps(more)).toEqual(po3Sweeps(base));
  });
});

describe("po3Outcome and po3Stats", () => {
  it("measures what followed: the other side reached by 12:00, and how far in the direction of the setup", () => {
    const bars = night("2026-10-21", "2026-10-20", "12:00");
    replaceAt(bars, at("2026-10-21", "03:00"), bar(at("2026-10-21", "03:00"), 108, 112, 107, 109)); // bearish, confirms at once at 109
    replaceAt(bars, at("2026-10-21", "08:00"), bar(at("2026-10-21", "08:00"), 105, 105, 98, 100)); // trades under the range low 100
    const [e] = po3Sweeps(bars);
    const o = po3Outcome(bars, e);
    expect(o.reachedOpposite).toBe(true);
    expect(o.favourableRange).toBeCloseTo((109 - 98) / (110 - 100), 5);
  });

  it("counts days, events, and the same measure on the days without one", () => {
    const bars = [...night("2026-10-21", "2026-10-20", "12:00"), ...night("2026-10-22", "2026-10-21", "12:00")];
    replaceAt(bars, at("2026-10-21", "03:00"), bar(at("2026-10-21", "03:00"), 108, 112, 107, 109));
    replaceAt(bars, at("2026-10-22", "08:00"), bar(at("2026-10-22", "08:00"), 105, 111, 99, 105)); // the quiet day touches both sides after 05:00
    const s = po3Stats(bars);
    expect(s.days).toBe(2);
    expect(s.events).toBe(1);
    expect(s.bearish).toBe(1);
    expect(s.baselineLow).toBe(1);
    expect(s.baselineHigh).toBe(1);
    expect(po3Stats([]).baselineLow).toBeUndefined();
  });
});
