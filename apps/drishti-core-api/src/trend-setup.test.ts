import { expect, test } from "bun:test";
import type { SetupResult, SignalRecord } from "@drishti/shared";
import { scanSymbols, TrendSetupService } from "./trend-setup.service";

// The scanner over fakes: a clock, an in-memory log, a stubbed checklist and a recording notifier. It must stay quiet while MCX is closed, store and send a
// READY setup once per market per India day, never store a WAIT, and store before it sends.
const OPEN = Date.parse("2026-11-05T09:00:00Z"); // Thursday 14:30 IST, MCX open
const CLOSED = Date.parse("2026-11-08T09:00:00Z"); // Sunday

function make(verdict: SetupResult["verdict"], now = OPEN) {
  const log = new Map<string, SignalRecord>();
  const sent: string[] = [];
  const svc = new TrendSetupService({ sql: {} } as never);
  (svc as { store: unknown }).store = { has: async (k: string) => log.has(k), add: async (r: SignalRecord) => (log.has(r.key) ? false : (log.set(r.key, r), true)) };
  svc.sources = { api: async () => undefined as never, health: async () => undefined, now: () => now };
  svc.scan = async (symbol) => ({ symbol, underlying: "CRUDEOIL", expiry: "2026-11-17", result: { verdict, summary: verdict, steps: [], bias: "bullish", side: "long", trigger: { status: "pass", detail: "", barTime: now / 1000 - 900, entry: 100, stop: 96, rPoints: 4, tp1: 104, tp2: 108 } } as unknown as SetupResult });
  svc.notify = async (rec) => void sent.push(log.has(rec.key) ? rec.key : "sent before stored");
  return { svc, log, sent };
}

test("a READY setup is stored and sent once per market per day", async () => {
  const { svc, log, sent } = make("ready");
  const first = await svc.tick();
  expect(first).toEqual(["trend-setup:MCX:CRUDEOIL:2026-11-05", "trend-setup:MCX:NATGASMINI:2026-11-05"]);
  expect(sent).toEqual(first); // each delivered after it was stored
  expect(log.get(first[0])).toMatchObject({ strategy: "trend-setup", status: "signal", signal: { side: "long", entry: 100 } });
  expect(await svc.tick()).toEqual([]); // later the same day: one a day
  expect(sent.length).toBe(2);
});

test("a WAIT is not stored; nothing runs while MCX is closed", async () => {
  const wait = make("wait");
  expect(await wait.svc.tick()).toEqual([]);
  expect(wait.log.size).toBe(0);
  expect(wait.svc.last.get("MCX:CRUDEOIL")).toMatchObject({ verdict: "wait" });
  const closed = make("ready", CLOSED);
  expect(await closed.svc.tick()).toEqual([]);
  expect(closed.sent).toEqual([]);
});

test("watched markets come from TREND_SETUP_SYMBOLS and only MCX futures count", () => {
  expect(scanSymbols({})).toEqual(["MCX:CRUDEOIL", "MCX:NATGASMINI"]);
  expect(scanSymbols({ TREND_SETUP_SYMBOLS: "MCX:CRUDEOILM, NYMEX:CL" })).toEqual(["MCX:CRUDEOILM"]);
});
