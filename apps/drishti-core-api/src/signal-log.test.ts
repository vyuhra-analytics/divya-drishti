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

// ---- the option leg: a fake database answering the five queries the recorded chain and the feed ask make
function fakeSql(opts: { snapshot: boolean; feedAsk?: number }) {
  const at = new Date("2026-10-27T13:25:00Z");
  const fut = { key: "MCX_FO|1", side: "FUT", expiry: "2026-11-17", strike: 0, lot: 100, lastPrice: 9600, depth: null };
  const legs = [9500, 9550, 9600, 9650, 9700].flatMap((strike, i) =>
    (["CE", "PE"] as const).map((side) => ({ key: `MCX_FO|${strike}${side === "CE" ? 1 : 2}`, side, expiry: "2026-11-17", strike, lot: 100, underlyingKey: "MCX_FO|1", lastPrice: 170, delta: side === "CE" ? 0.62 - i * 0.05 : -(0.62 - (4 - i) * 0.05), depth: { buy: [{ quantity: 10, price: 168 }], sell: [{ quantity: 10, price: [240, 200, 170, 140, 110][side === "CE" ? i : 4 - i] }] } })),
  );
  const sql = (strings: TemplateStringsArray) => {
    const q = strings.join("?");
    if (q.includes("FROM feed_quotes")) return Promise.resolve(opts.feedAsk ? [{ price: opts.feedAsk, ask: opts.feedAsk, delta: 0.5, t: Date.parse("2026-10-27T13:34:50Z") }] : []);
    if (q.includes("max(time) AS t FROM quote_snapshots WHERE time <=")) return Promise.resolve(opts.snapshot ? [{ t: at }] : [{ t: null }]);
    if (q.includes("FROM quote_snapshots WHERE")) return Promise.resolve([{ t: null }]);
    if (q.includes("FROM quote_snapshots s JOIN contract_master")) return Promise.resolve([fut, ...legs]);
    return Promise.resolve([]);
  };
  return sql as never;
}
const signalRecord = (side: "long" | "short"): SignalRecord => ({ key: "k", strategy: "usib", symbol: "MCX:CRUDEOIL", at: OPEN, status: "signal", candles: [], notes: [], signal: { side, candleTime: OPEN / 1000 + 300, closedAt: OPEN / 1000 + 600, entry: 9600, rPoints: 30, stop: 9570, tp1: 9630, tp2: 9660 } });

test("a logged signal gets the option to buy: the call or put the screen would pick, with premium levels from the recorded chain", async () => {
  const svc = new SignalLogService({ sql: fakeSql({ snapshot: true }), redis: {} } as never, {} as never);
  const long = await svc.withOption(signalRecord("long"));
  expect(long.option).toMatchObject({ type: "CE", strike: 9600, expiry: "2026-11-17", units: 100 });
  expect(long.option!.basis).toContain("snapshot");
  expect(long.option!.stop).toBeLessThan(long.option!.premium);
  expect(long.option!.tp2).toBeGreaterThan(long.option!.tp1);
  const short = await svc.withOption(signalRecord("short"));
  expect(short.option).toMatchObject({ type: "PE" });
});

test("a live-feed ask within two minutes of the signal replaces the snapshot's; with no snapshot the record says so and invents nothing", async () => {
  const svc = new SignalLogService({ sql: fakeSql({ snapshot: true, feedAsk: 181 }), redis: {} } as never, {} as never);
  const r = await svc.withOption(signalRecord("long"));
  expect(r.option!.premium).toBe(181);
  expect(r.option!.basis).toContain("live-feed ask");
  const none = await new SignalLogService({ sql: fakeSql({ snapshot: false }), redis: {} } as never, {} as never).withOption(signalRecord("long"));
  expect(none.option).toBeUndefined();
  expect(none.optionNote).toContain("no option chain snapshot");
  const quiet: SignalRecord = { ...signalRecord("long"), status: "no_signal", signal: undefined };
  expect((await svc.withOption(quiet)).option).toBeUndefined(); // only a signal has an option leg
});
