import { expect, test } from "bun:test";
import { evaluateReportDay, recentUsOpens, reportKey, usibKey, type Bar, type SignalRecord } from "@drishti/shared";
import { SignalLogService } from "./signal-log.service";

// The service over fakes: a report stored with its official time, candles from a stub, an in-memory log. It must log each closed evening once, only after the
// entry window is over, skip USIB on a report day, and leave an evening with no candles to be tried again.
const OPEN = Date.parse("2026-10-27T13:30:00Z"); // a Tuesday 09:30 New York (summer time)
const RELEASE = Date.parse("2026-10-28T14:30:00Z"); // Wednesday 10:30 New York

function setup(over: { weeks?: { weekEnding: string; officialReleaseAt?: number }[]; bars?: Bar[] } = {}) {
  const log = new Map<string, SignalRecord>();
  const svc = new SignalLogService({ sql: {}, redis: {} } as never, { store: { weeks: async (c: string) => (c === "WPSR" ? (over.weeks ?? [{ weekEnding: "2026-10-23", officialReleaseAt: RELEASE }]) : []) } } as never);
  (svc as { store: unknown }).store = { has: async (k: string) => log.has(k), add: async (r: SignalRecord) => (log.has(r.key) ? false : (log.set(r.key, r), true)) };
  (svc as unknown as { reportDay: unknown }).reportDay = async (_c: unknown, _w: unknown, releaseAt: number) => evaluateReportDay({ code: "WPSR", releaseAt, bars: [], side: "none" });
  svc.bars = async () => over.bars ?? [];
  return { svc, log };
}
const bar = (time: number, c: number, v = 100): Bar => ({ time, open: c, high: c + 1, low: c - 1, close: c, volume: v });
const candles = (openAt: number) => Array.from({ length: 60 }, (_, i) => bar(openAt / 1000 - 3600 - 25 * 300 + i * 300, 105));

test("a report day is logged once, after its window has closed", async () => {
  const { svc, log } = setup();
  const reportOnly = (keys: string[]) => keys.filter((k) => k.startsWith("report-day"));
  expect(reportOnly(await svc.tick(RELEASE + 20 * 60_000))).toEqual([]); // the entry window is still running
  expect(reportOnly(await svc.tick(RELEASE + 40 * 60_000))).toEqual([reportKey("WPSR", RELEASE)]);
  expect(log.get(reportKey("WPSR", RELEASE))).toMatchObject({ strategy: "report-day", status: "no_bars" });
  expect(await svc.tick(RELEASE + 41 * 60_000)).toEqual([]); // everything is already in the log: nothing new, nothing rewritten
});

test("USIB: an evening with candles is logged for both markets; with no candles it is left to be tried again", async () => {
  const quiet = setup({ weeks: [], bars: candles(OPEN) });
  const now = OPEN + 90 * 60_000;
  const stored = await quiet.svc.tick(now);
  expect(stored).toContain(usibKey("MCX:CRUDEOIL", OPEN));
  expect(stored).toContain(usibKey("MCX:NATGASMINI", OPEN));
  expect(quiet.log.get(usibKey("MCX:CRUDEOIL", OPEN))).toMatchObject({ strategy: "usib", status: "no_signal" });
  const empty = setup({ weeks: [], bars: [] });
  expect(await empty.svc.tick(now)).toEqual([]);
  expect(empty.log.size).toBe(0);
  expect(await setup({ weeks: [], bars: candles(OPEN) }).svc.tick(OPEN + 30 * 60_000)).not.toContain(usibKey("MCX:CRUDEOIL", OPEN)); // the entry window is not over
});

test("USIB on the New York day an EIA report was out is logged as skipped with the reason", async () => {
  const { svc, log } = setup({ bars: candles(OPEN) });
  const wed = recentUsOpens(RELEASE + 6 * 3600_000, 1)[0]; // Wednesday's cash open
  const stored = await svc.tick(RELEASE + 6 * 3600_000);
  expect(stored).toContain(usibKey("MCX:CRUDEOIL", wed));
  expect(log.get(usibKey("MCX:CRUDEOIL", wed))).toMatchObject({ status: "skipped" });
  expect(log.get(usibKey("MCX:CRUDEOIL", wed))!.reason).toContain("EIA report");
});
