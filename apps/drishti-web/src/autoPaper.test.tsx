import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { OptionLegSignal } from "@drishti/shared";
import { AutoPaper } from "./AutoPaper";
import { useStore } from "./store";

// A fake paper server (the stream's /paper API) and a fixed clock: the component buys the signal's option, follows what the server does with it, and
// never anything else. The server (not this component) holds the stop and target and runs TP1, the trail and the time exit.

const RELEASE = Date.UTC(2026, 9, 29, 14, 30); // Thu 29 Oct 2026, 10:30 New York = 20:00 IST
const CANDLE = RELEASE / 1000 + 300; // the 5-minute candle that closed beyond the range, closes at 20:10 IST
const AFTER_CLOSE = (CANDLE + 300) * 1000 + 20_000; // 20 seconds after the signal candle closed

const LEG: OptionLegSignal = { key: "MCX_FO|583810", label: "NATGASMINI 290 CE 2026-11-24", type: "CE", strike: 290, expiry: "2026-11-24", units: 250, premium: 8.4, delta: 0.52, cost: 2100, rPremium: 1.2, rupeeR: 300, stop: 7.2, tp1: 9.6, tp2: 10.8, trail: 0.6 };

interface Fake {
  calls: { method: string; path: string; body?: any }[];
  account: "ok" | "missing";
  order?: { ok: boolean; status?: number; error?: string };
  /** the first n order attempts are answered "no live premium yet" */
  noPremium: number;
  positions: object[];
  trades: object[];
}
let fake: Fake;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {}
  fake = { calls: [], account: "ok", noPremium: 0, positions: [], trades: [] };
  setSystemTime(new Date(AFTER_CLOSE));
  useStore.setState({ options: {} });
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const full = new URL(String(url), "http://x").pathname;
    const path = full.slice(full.indexOf("/paper") + 6);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fake.calls.push({ method, path, body });
    const json = (status: number, data: object) => ({ ok: status < 400, status, json: async () => data }) as Response;
    if (method === "GET" && path === "/accounts/auto") return fake.account === "missing" ? json(404, { error: "no such account" }) : json(200, { state: { positions: fake.positions, trades: fake.trades } });
    if (method === "POST" && path === "/accounts") {
      fake.account = "ok";
      return json(201, {});
    }
    if (method === "POST" && path === "/accounts/auto/orders") {
      if (fake.noPremium > 0) {
        fake.noPremium--;
        return json(503, { error: "no live premium for this option yet: the feed has been asked to watch it, try again in a few seconds" });
      }
      if (fake.order && !fake.order.ok) return json(fake.order.status ?? 422, { error: fake.order.error });
      fake.positions = [{ id: "p1", stop: body.stop, plan: body.plan }];
      return json(201, { position: { id: "p1", entry: 8.5, openedAt: Date.now() } });
    }
    return json(404, { error: "unexpected request" });
  }) as never;
});
afterEach(() => {
  cleanup();
  setSystemTime();
});

const signal = { side: "long" as const, candleTime: CANDLE };
const props = { strategy: "report-day" as const, recordKey: String(RELEASE), releaseAt: RELEASE, option: LEG, tickMs: 15 };
const orders = () => fake.calls.filter((c) => c.method === "POST" && c.path === "/accounts/auto/orders");
const arm = () => localStorage.setItem("drishti-autopaper-armed", "1");
const disarm = () => localStorage.setItem("drishti-autopaper-armed", "0");
const wait = (ms = 80) => act(async () => await new Promise((r) => setTimeout(r, ms)));

test("on by default: with nothing saved, a fresh signal is traded", async () => {
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  expect(orders()).toHaveLength(1);
});

test("switched off, a signal places nothing, but the option signal is shown, and the choice is kept", async () => {
  disarm();
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await wait();
  expect(orders()).toHaveLength(0);
  expect(screen.getByText(/Off: nothing is traded automatically/)).toBeTruthy();
  expect(screen.getByTestId("auto-option-signal").textContent).toMatch(/buy NATGASMINI 290 CE.*stop 7\.20.*TP1 9\.60.*TP2 10\.80/);
});

test("armed, a fresh signal buys the option: one lot, premium stop and TP2 target, labels, and the plan the server carries out", async () => {
  arm();
  const onEvent = mock((_m: string) => {});
  render(<AutoPaper {...props} signal={signal} onEvent={onEvent} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  expect(orders()).toHaveLength(1); // one order, however many ticks
  const b = orders()[0].body;
  expect(b).toMatchObject({ option: { key: LEG.key }, side: "buy", lots: 1, stop: 7.2, target: 10.8, tag: "auto", strategy: "report-day", client_order_id: `auto-${RELEASE}`, r_points: 1.2 });
  expect(b.plan).toEqual({ tp1: 9.6, close_at: new Date(RELEASE + 90 * 60_000).toISOString() });
  expect(onEvent.mock.calls[0][0]).toMatch(/paper bought 1 lot NATGASMINI 290 CE.*at 8\.50/);
  expect(screen.getByTestId("auto-open").textContent).toContain("8.50"); // the fill the server reported
});

test("USIB: no target, and the server is told to trail the premium after TP2", async () => {
  arm();
  render(<AutoPaper {...props} strategy="usib" recordKey="usib:1" timeStop={{ fromMin: 150, toMin: 180 }} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  const b = orders()[0].body;
  expect("target" in b).toBe(false);
  expect(b.plan).toMatchObject({ tp1: 9.6, tp2: 10.8, trail: 0.6, candle_sec: 300 });
});

test("the auto account is created when it does not exist yet", async () => {
  arm();
  fake.account = "missing";
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  expect(fake.calls.find((c) => c.method === "POST" && c.path === "/accounts")?.body).toMatchObject({ id: "auto", capital: 70000 });
});

test("a signal that is already stale is skipped, never chased", async () => {
  arm();
  setSystemTime(new Date(AFTER_CLOSE + 5 * 60_000));
  const onEvent = mock((_m: string) => {});
  render(<AutoPaper {...props} signal={signal} onEvent={onEvent} />);
  await waitFor(() => expect(screen.getByTestId("auto-skipped").textContent).toMatch(/more than 2 minutes old/));
  expect(orders()).toHaveLength(0);
  expect(onEvent.mock.calls[0][0]).toMatch(/skipped/);
});

test("no option for the signal is a skip with the reason, never a trade of something else", async () => {
  arm();
  render(<AutoPaper {...props} option={undefined} optionReason="No trade: 1R is over the ₹2,000 cap even on the lowest-delta strike that fits." signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-skipped").textContent).toMatch(/over the .*2,000 cap/));
  expect(orders()).toHaveLength(0);
});

test("no live premium yet is retried on the next tick, not skipped", async () => {
  arm();
  fake.noPremium = 2;
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  expect(orders()).toHaveLength(3); // two refusals, then the fill
  expect(screen.queryByTestId("auto-skipped")).toBeNull();
});

test("a refused order is recorded with the reason and not retried", async () => {
  arm();
  fake.order = { ok: false, status: 422, error: "the market is closed" };
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-skipped").textContent).toMatch(/the market is closed/));
  await wait();
  expect(orders()).toHaveLength(1);
});

test("when the server moves the stop at TP1 the panel shows it and says so once", async () => {
  arm();
  const onEvent = mock((_m: string) => {});
  render(<AutoPaper {...props} signal={signal} onEvent={onEvent} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  fake.positions = [{ id: "p1", stop: 8.5, plan: { tp1: 9.6, tp1Done: true } }];
  await waitFor(() => expect(screen.getByText(/Stop 8\.50 \(moved\)/)).toBeTruthy());
  expect(onEvent.mock.calls.filter((c) => /TP1 reached/.test(c[0]))).toHaveLength(1);
});

test("the time exit and a stop that fired on the server are noticed and recorded", async () => {
  arm();
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  fake.positions = [];
  fake.trades = [{ id: "p1", closedAt: Date.now(), exit: 9.1, net: 150, reason: "time" }];
  await waitFor(() => expect(screen.getByTestId("auto-closed").textContent).toMatch(/time exit/));
  expect(screen.getByTestId("auto-closed").textContent).toMatch(/net ₹150/);
});

test("a reload carries on: the record is read back and nothing is placed twice", async () => {
  arm();
  const first = render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  first.unmount();
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await wait();
  expect(orders()).toHaveLength(1);
  expect(screen.getByTestId("auto-open")).toBeTruthy();
});
