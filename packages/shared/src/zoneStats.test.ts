import { describe, expect, it } from "bun:test";
import { PROFILE_WINDOWS, summarizeWindows, zoneDays, type ProfileBar } from "./zoneStats";
import { ZONES } from "./sessionZones";

const edt = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 + 4 * 3600;
const bar = (time: number, o: number, h: number, l: number, c: number, volume = 10): ProfileBar => ({ time, open: o, high: h, low: l, close: c, volume });
/** one-minute bars across [from, to) of a New York day with the given high/low spread around `mid` */
const span = (day: string, from: string, to: string, mid: number, half: number): ProfileBar[] => {
  const out: ProfileBar[] = [];
  for (let t = edt(day, from); t < edt(day, to); t += 60) out.push(bar(t, mid, mid + half, mid - half, mid));
  return out;
};

describe("PROFILE_WINDOWS", () => {
  it("cover the whole New York day without overlap, and the killzones are the five of the study", () => {
    const sorted = [...PROFILE_WINDOWS].sort((a, b) => a.from - b.from);
    expect(sorted[0].from).toBe(0);
    expect(sorted[sorted.length - 1].to).toBe(24 * 60);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].from).toBe(sorted[i - 1].to);
    expect(PROFILE_WINDOWS.filter((w) => w.killzone).map((w) => w.id).sort()).toEqual(ZONES.map((z) => z.id).sort());
  });
});

describe("zoneDays", () => {
  it("gives each window's high, low, range, average and volume for the day", () => {
    const bars = [...span("2026-10-21", "07:00", "10:00", 100, 1), bar(edt("2026-10-21", "08:00"), 100, 105, 99, 101)];
    // the 08:00 minute is replaced by the wide one: filter the duplicate out
    const unique = bars.filter((b, i) => !(b.time === edt("2026-10-21", "08:00") && i < bars.length - 1));
    const [d] = zoneDays(unique);
    expect(d).toMatchObject({ day: "2026-10-21", window: "nyam", label: "New York AM", killzone: true, high: 105, low: 99, range: 6, bars: 180 });
    expect(d.average).toBeCloseTo((179 * 100 + 101) / 180, 6);
    expect(d.volume).toBe(1800);
  });

  it("skips a window the bars cover too little of (an MCX chart sees 30 of the 240 Asian minutes) and hourly bars", () => {
    const thin = span("2026-10-20", "23:30", "24:00".replace("24:00", "23:59"), 100, 1);
    expect(zoneDays(thin).filter((d) => d.window === "asian")).toEqual([]);
    const hourly = [bar(edt("2026-10-21", "07:00"), 1, 2, 0, 1), bar(edt("2026-10-21", "08:00"), 1, 2, 0, 1)];
    expect(zoneDays(hourly)).toEqual([]);
  });

  it("keeps days and windows apart and in order", () => {
    const bars = [...span("2026-10-21", "02:00", "05:00", 100, 1), ...span("2026-10-21", "07:00", "10:00", 100, 2), ...span("2026-10-22", "02:00", "05:00", 100, 3)];
    const days = zoneDays(bars);
    expect(days.map((d) => [d.day, d.window])).toEqual([["2026-10-21", "london"], ["2026-10-21", "nyam"], ["2026-10-22", "london"]]);
    expect(days.map((d) => d.range)).toEqual([2, 4, 6]);
  });
});

describe("summarizeWindows", () => {
  it("averages the range over days and compares windows by the range of an average bar", () => {
    const bars = [...span("2026-10-21", "07:00", "10:00", 100, 1), ...span("2026-10-22", "07:00", "10:00", 100, 3), ...span("2026-10-21", "12:00", "13:30", 100, 0.5)];
    const s = summarizeWindows(zoneDays(bars), bars);
    const nyam = s.find((x) => x.window === "nyam")!;
    const lunch = s.find((x) => x.window === "lunch")!;
    expect(nyam.days).toBe(2);
    expect(nyam.avgRange).toBe(4); // (2 + 6) / 2
    expect(nyam.avgBarRangePct).toBeCloseTo(4, 6); // bar ranges 2 and 6 points on 100
    expect(lunch.avgBarRangePct).toBeCloseTo(1, 6);
    expect(nyam.volumePerMin).toBe(10);
    expect(nyam.killzone).toBe(true);
    expect(lunch.killzone).toBe(false);
  });

  it("nothing for a window with no usable day", () => {
    expect(summarizeWindows([], [])).toEqual([]);
  });
});
