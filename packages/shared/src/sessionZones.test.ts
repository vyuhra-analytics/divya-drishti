import { describe, expect, it, test } from "bun:test";
import { barSeconds, nyClock, sessionLevels, zoneAt, ZONES } from "./sessionZones";
import type { Bar } from "./index";

// New York wall clock to epoch seconds, written in UTC with the zone's offset for the date (EDT -4 until 2026-11-01, EST -5 after).
const ny = (date: string, hhmm: string, offsetH: number) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 + offsetH * 3600;
const edt = (date: string, hhmm: string) => ny(date, hhmm, 4);
const est = (date: string, hhmm: string) => ny(date, hhmm, 5);

describe("nyClock and zoneAt", () => {
  it("reads New York wall time across daylight saving: the same 07:00 is a different UTC hour in March", () => {
    expect(nyClock(est("2026-03-06", "07:00"))).toEqual({ date: "2026-03-06", minutes: 420 });
    expect(nyClock(edt("2026-03-09", "07:00"))).toEqual({ date: "2026-03-09", minutes: 420 });
    expect(new Date(est("2026-03-06", "07:00") * 1000).getUTCHours()).toBe(12);
    expect(new Date(edt("2026-03-09", "07:00") * 1000).getUTCHours()).toBe(11);
  });

  it("puts each window's first minute in and its end minute out", () => {
    expect(zoneAt(edt("2026-10-21", "02:00"))).toBe("london");
    expect(zoneAt(edt("2026-10-21", "04:59"))).toBe("london");
    expect(zoneAt(edt("2026-10-21", "05:00"))).toBeUndefined();
    expect(zoneAt(edt("2026-10-21", "07:00"))).toBe("nyam");
    expect(zoneAt(edt("2026-10-21", "10:00"))).toBe("lclose"); // the release at 10:30 falls here
    expect(zoneAt(edt("2026-10-21", "10:30"))).toBe("lclose");
    expect(zoneAt(edt("2026-10-21", "12:00"))).toBeUndefined();
    expect(zoneAt(edt("2026-10-21", "13:30"))).toBe("nypm");
    expect(zoneAt(edt("2026-10-21", "16:00"))).toBeUndefined();
    expect(zoneAt(edt("2026-10-21", "20:00"))).toBe("asian");
    expect(zoneAt(edt("2026-10-21", "23:59"))).toBe("asian");
    expect(zoneAt(edt("2026-10-22", "00:00"))).toBeUndefined();
  });

  it("only the zones switched on", () => {
    expect(zoneAt(edt("2026-10-21", "03:00"), ["nyam"])).toBeUndefined();
    expect(zoneAt(edt("2026-10-21", "03:00"), ["london", "nyam"])).toBe("london");
  });

  it("the windows do not overlap", () => {
    const sorted = [...ZONES].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].from).toBeGreaterThanOrEqual(sorted[i - 1].to);
  });
});

const bar = (time: number, o: number, h: number, l: number, c: number): Bar => ({ time, open: o, high: h, low: l, close: c, volume: 1 });
/** five-minute bars from `from` (epoch s) for `count` bars; price steps up a point a bar from `base` */
const run = (from: number, count: number, base: number): Bar[] => Array.from({ length: count }, (_, i) => bar(from + i * 300, base + i, base + i + 0.5, base + i - 0.5, base + i + 0.2));

describe("sessionLevels", () => {
  it("draws the midnight open from the 00:00 bar and the Asian range from midnight, never earlier", () => {
    const asian = run(edt("2026-10-20", "20:00"), 48, 100); // 20:00 to 24:00, 4 hours
    const after = run(edt("2026-10-21", "00:00"), 24, 200); // 00:00 to 02:00
    const bars = [...asian, ...after];
    const lv = sessionLevels(bars);
    expect(barSeconds(bars)).toBe(300);
    // inside the Asian window itself: no range yet, no midnight price of the next day
    expect(lv.asiaHigh[10]).toBeNull();
    expect(lv.midnight[10]).toBeNull();
    // from the 00:00 bar on
    expect(lv.midnight[48]).toBe(200);
    expect(lv.midnight[60]).toBe(200);
    expect(lv.asiaHigh[48]).toBe(147.5); // last Asian bar: base 100 + 47 = 147, high 147.5
    expect(lv.asiaLow[48]).toBe(99.5);
  });

  it("an MCX-like chart that sees only the last half hour of the Asian window draws no range, but still has the midnight price", () => {
    const bars = [...run(edt("2026-10-20", "23:30"), 6, 100), ...run(edt("2026-10-21", "00:00"), 12, 110)];
    const lv = sessionLevels(bars);
    expect(lv.asiaHigh.every((v) => v === null)).toBe(true);
    expect(lv.midnight[6]).toBe(110);
  });

  it("with hourly bars the midnight price is the close of the bar that ends at midnight, and nothing when no bar lines up", () => {
    const hourly = (from: number, count: number, base: number): Bar[] => Array.from({ length: count }, (_, i) => bar(from + i * 3600, base + i, base + i + 1, base + i - 1, base + i + 0.5));
    const lined = [...hourly(edt("2026-10-20", "22:00"), 2, 100), ...hourly(edt("2026-10-21", "00:00"), 3, 105)];
    expect(sessionLevels(lined).midnight[2]).toBe(105); // a bar opens at 00:00: its open
    const offset = hourly(edt("2026-10-20", "21:30"), 6, 100); // bars open at :30, none at or ending at midnight
    expect(sessionLevels(offset).midnight.every((v) => v === null)).toBe(true);
  });

  it("each New York day has its own levels, and a daily chart or a single bar draws none", () => {
    const d1 = [...run(edt("2026-10-20", "20:00"), 48, 100), ...run(edt("2026-10-21", "00:00"), 12, 150)];
    const d2 = [...run(edt("2026-10-21", "20:00"), 48, 300), ...run(edt("2026-10-22", "00:00"), 12, 400)];
    const lv = sessionLevels([...d1, ...d2]);
    expect(lv.midnight[48]).toBe(150);
    expect(lv.midnight[60 + 48]).toBe(400);
    expect(lv.midnight[60 + 10]).toBe(150); // the evening of the same New York day still shows that day's midnight price, not the next day's
    expect(sessionLevels([bar(1, 1, 2, 0, 1)]).midnight).toEqual([null]);
    const daily = [bar(1_700_000_000, 1, 2, 0, 1), bar(1_700_086_400, 1, 2, 0, 1)];
    expect(sessionLevels(daily).midnight).toEqual([null, null]);
  });

  it("is causal: appending later bars never changes a level already drawn", () => {
    const base = [...run(edt("2026-10-20", "20:00"), 48, 100), ...run(edt("2026-10-21", "00:00"), 24, 200)];
    const a = sessionLevels(base);
    const b = sessionLevels([...base, ...run(edt("2026-10-21", "02:00"), 24, 9999)]);
    for (const k of ["midnight", "asiaHigh", "asiaLow"] as const) expect(b[k].slice(0, base.length)).toEqual(a[k]);
  });
});

import { istWindow as _istWindow, londonClock as _londonClock, toIst as _toIst, zoneAt as _zoneAt, LONDON_OPEN_WINDOW as _LDN } from "./sessionZones";

const utc = (iso: string) => Date.parse(`${iso}Z`) / 1000;

test("Indian time follows daylight saving in New York and London", () => {
  // US summer time (EDT, UTC-4): 20:00 NY is 05:30 IST; US winter (EST, UTC-5): 06:30 IST
  expect(_istWindow({ from: 20 * 60, to: 24 * 60 }, utc("2026-10-28T12:00:00"))).toBe("05:30-09:30 IST");
  expect(_istWindow({ from: 20 * 60, to: 24 * 60 }, utc("2026-11-03T12:00:00"))).toBe("06:30-10:30 IST");
  // the 10:30 ET release: 20:00 IST in summer time, 21:00 after the clock change
  expect(_toIst(10 * 60 + 30, utc("2026-10-28T12:00:00"))).toBe(20 * 60);
  expect(_toIst(10 * 60 + 30, utc("2026-11-03T12:00:00"))).toBe(21 * 60);
  // London 07:00-10:00 is 12:30-15:30 IST in London winter time, 11:30-14:30 in its summer time
  expect(_istWindow(_LDN, utc("2026-10-28T12:00:00"), "london")).toBe("12:30-15:30 IST");
  expect(_istWindow(_LDN, utc("2026-07-15T12:00:00"), "london")).toBe("11:30-14:30 IST");
});

test("the London zone on the London cash open moves with London's clock, not New York's", () => {
  // 28 Oct 2026: Europe is back on winter time, the US is not: 07:30 London = 03:30 New York
  const t = utc("2026-10-28T07:30:00");
  expect(_zoneAt(t)).toBe("london"); // New York's 02:00-05:00 happens to hold it too
  // 06:30 London = 02:30 New York: the New York clock calls it London, the London clock does not (the cash market is not open yet)
  const early = utc("2026-10-28T06:30:00");
  expect(_zoneAt(early)).toBe("london");
  expect(_zoneAt(early, undefined, true)).toBeUndefined();
  // 09:30 London = 05:30 New York: outside New York's window, inside the London open's
  const late = utc("2026-10-28T09:30:00");
  expect(_zoneAt(late)).toBeUndefined();
  expect(_zoneAt(late, undefined, true)).toBe("london");
  expect(_londonClock(late).minutes).toBe(9 * 60 + 30);
});
