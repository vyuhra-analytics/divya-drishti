import { expect, test } from "bun:test";
import { evaluateReportDay, evaluateUsib, nyDay, recentUsOpens, reportKey, usibKey, windowClosed } from "./signalLog";
import type { DayBar } from "./reportDay";
import type { UsibBar } from "./usib";

const REL = 1_793_000_000 - (1_793_000_000 % 300);
const RELMS = REL * 1000;
const bar = (time: number, o: number, h: number, l: number, c: number): DayBar => ({ time, open: o, high: h, low: l, close: c });
/** 14 candles before the hour so ATR(14) exists, then the hour (range 100..110), then a window of 5-minute candles */
const lead = Array.from({ length: 30 }, (_, i) => bar(REL - 3600 - 30 * 300 + i * 300, 105, 108, 102, 105));
const hour = Array.from({ length: 12 }, (_, i) => bar(REL - 3600 + i * 300, 105, i === 4 ? 110 : 107, i === 7 ? 100 : 103, 105));
const win = (closes: number[]) => closes.map((c, i) => bar(REL + i * 300, 105, Math.max(105, c) + 0.5, Math.min(105, c) - 0.5, c));
const input = (closes: number[], over = {}) => ({ code: "WPSR" as const, releaseAt: RELMS, bars: [...lead, ...hour, ...win(closes)], change: -6.2, forecast: -1.1, surprise: -5.1, side: "long" as const, ...over });

test("a close above the range on the allowed side is the signal; the record carries the range, every candle and the levels", () => {
  const r = evaluateReportDay(input([106, 112, 113, 113, 113, 113, 113]));
  expect(r.status).toBe("signal");
  expect(r.key).toBe(reportKey("WPSR", RELMS));
  expect(r.range).toMatchObject({ high: 110, low: 100, width: 10 });
  expect(r.signal).toMatchObject({ side: "long", candleTime: REL + 300, entry: 105 });
  expect(r.signal!.stop).toBeLessThan(r.signal!.entry!);
  expect(r.signal!.tp2).toBeGreaterThan(r.signal!.tp1!);
  expect(r.candles.map((c) => c.state).slice(0, 3)).toEqual(["inside", "above", "above"]);
  expect(r.report).toMatchObject({ code: "WPSR", forecast: -1.1, surprise: -5.1, threshold: 3, side: "long" });
});

test("a break against the surprise is logged as skipped, not as a signal, and says why there was none", () => {
  const r = evaluateReportDay(input([106, 98, 97, 99, 100, 101, 102]));
  expect(r.status).toBe("no_signal");
  expect(r.skippedAgainst).toBe(3);
  expect(r.candles.filter((c) => c.note === "against the surprise")).toHaveLength(3);
  expect(r.reason).toContain("against the surprise");
});

test("with no side from the number a break either way trades, and the missing forecast is noted", () => {
  const r = evaluateReportDay(input([106, 98, 97, 99, 100, 101, 102], { side: "none", forecast: undefined, surprise: undefined }));
  expect(r.status).toBe("signal");
  expect(r.signal!.side).toBe("short");
  expect(r.notes.join(" ")).toContain("no forecast");
});

test("an evening inside the range, with no candles, or with no hour before the print, is recorded as such", () => {
  expect(evaluateReportDay(input([104, 106, 103, 108, 104, 105, 106])).reason).toBe("no 5-minute close beyond the range in the window");
  expect(evaluateReportDay(input([], { bars: [] })).status).toBe("no_bars");
  expect(evaluateReportDay(input([106], { bars: win([106, 112]) })).status).toBe("no_range");
});

test("the log only reads closed candles: a break in the last candle before the cut-off is judged, one after it never is", () => {
  const after = evaluateReportDay(input([104, 104, 104, 104, 104, 104, 112])); // the 7th candle opens 30 minutes after the print
  expect(after.status).toBe("no_signal");
});

const ubar = (time: number, o: number, h: number, l: number, c: number, v: number): UsibBar => ({ ...bar(time, o, h, l, c), volume: v });

test("USIB: a break with volume and the right side of VWAP is a signal; a break on thin volume is logged as filtered", () => {
  const OPEN = REL; // any 5-minute boundary works for the pure rule
  const pre = Array.from({ length: 40 }, (_, i) => ubar(OPEN - 3600 - 28 * 300 + i * 300, 105, 107, 103, 105, 100));
  const good = [...pre, ubar(OPEN, 105, 106, 104, 105, 100), ubar(OPEN + 300, 105, 113, 105, 112, 400), ubar(OPEN + 600, 112, 114, 111, 113, 100)];
  const r = evaluateUsib({ symbol: "MCX:CRUDEOIL", openAt: OPEN * 1000, bars: good });
  expect(r.status).toBe("signal");
  expect(r.key).toBe(usibKey("MCX:CRUDEOIL", OPEN * 1000));
  expect(r.signal!.side).toBe("long");
  expect(r.signal!.tp2Source).toBeDefined();
  expect(r.notes.join(" ")).toContain("2R default");
  const thin = [...pre, ubar(OPEN, 105, 106, 104, 105, 100), ubar(OPEN + 300, 105, 113, 105, 112, 90), ubar(OPEN + 600, 112, 112, 111, 112, 90)];
  const t = evaluateUsib({ symbol: "MCX:CRUDEOIL", openAt: OPEN * 1000, bars: thin });
  expect(t.status).toBe("no_signal");
  expect(t.candles.some((c) => c.note?.includes("volume"))).toBe(true);
  expect(t.reason).toContain("failed the volume or VWAP filter");
});

test("recentUsOpens follows daylight saving and skips weekends; windowClosed waits for the window and three minutes", () => {
  const now = Date.parse("2026-10-30T20:00:00Z"); // a Friday evening, US summer time still on
  const opens = recentUsOpens(now, 3);
  expect(opens.map((o) => new Date(o).toISOString())).toEqual(["2026-10-28T13:30:00.000Z", "2026-10-29T13:30:00.000Z", "2026-10-30T13:30:00.000Z"]);
  const winter = recentUsOpens(Date.parse("2026-11-03T20:00:00Z"), 1);
  expect(new Date(winter.at(-1)!).toISOString()).toBe("2026-11-03T14:30:00.000Z"); // the clock changed on 1 Nov
  expect(recentUsOpens(Date.parse("2026-11-01T20:00:00Z"), 1)).toEqual([]); // a Sunday, and Saturday before it
  expect(nyDay(Date.parse("2026-10-30T02:00:00Z"))).toBe("2026-10-29");
  expect(windowClosed("report-day", RELMS, RELMS + 32 * 60_000)).toBe(false);
  expect(windowClosed("report-day", RELMS, RELMS + 33 * 60_000)).toBe(true);
  expect(windowClosed("usib", RELMS, RELMS + 62 * 60_000)).toBe(false);
  expect(windowClosed("usib", RELMS, RELMS + 63 * 60_000)).toBe(true);
});
