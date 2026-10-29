import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { AutoPaper } from "./AutoPaper";
import { useStore } from "./store";

// A fake paper server (the stream's /paper API) and a fixed clock: the component places, manages and closes a simulated futures trade, and never anything else.

const RELEASE = Date.UTC(2026, 9, 29, 14, 30); // Thu 29 Oct 2026, 10:30 New York = 20:00 IST
const CANDLE = RELEASE / 1000 + 300; // the 5-minute candle that closed beyond the range: 20:05 IST, closes at 20:10
const AFTER_CLOSE = (CANDLE + 300) * 1000 + 20_000; // 20 seconds after the signal candle closed
const SYMBOL = "MCX:NATGASMINI";

interface Fake {
  calls: { method: string; path: string; body?: any }[];
  account: "ok" | "missing";
  order?: { ok: boolean; status?: number; error?: string };
  open: boolean;
  trade?: object;
}
let fake: Fake;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {}
  fake = { calls: [], account: "ok", open: true };
  setSystemTime(new Date(AFTER_CLOSE));
  useStore.setState({ quotes: { [SYMBOL]: { symbol: SYMBOL, price: 291.2, bid: 291.1, ask: 291.2, time: AFTER_CLOSE, source: "upstox" } as never } });
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const full = new URL(String(url), "http://x").pathname;
    const path = full.slice(full.indexOf("/paper") + 6); // the stream may sit behind a proxy prefix
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fake.calls.push({ method, path, body });
    const json = (status: number, data: object) => ({ ok: status < 400, status, json: async () => data }) as Response;
    if (method === "GET" && path === "/accounts/auto") return fake.account === "missing" ? json(404, { error: "no such account" }) : json(200, { state: { positions: fake.open ? [{ id: "p1" }] : [], trades: fake.trade ? [fake.trade] : [] } });
    if (method === "POST" && path === "/accounts") {
      fake.account = "ok";
      return json(201, {});
    }
    if (method === "POST" && path === "/accounts/auto/orders") {
      if (fake.order && !fake.order.ok) return json(fake.order.status ?? 422, { error: fake.order.error });
      return json(201, { position: { id: "p1", entry: 291.3, openedAt: Date.now() } });
    }
    if (method === "PATCH" && path === "/accounts/auto/positions/p1") return json(200, { position: { id: "p1" } });
    if (method === "POST" && path === "/accounts/auto/positions/p1/close") return json(200, { trade: { closedAt: Date.now(), exit: 291.1, net: -120 } });
    return json(404, { error: "unexpected request" });
  }) as never;
});
afterEach(() => {
  cleanup();
  setSystemTime();
});

const signal = { side: "long" as const, candleTime: CANDLE, rPoints: 3 };
const props = { strategy: "report-day" as const, recordKey: String(RELEASE), releaseAt: RELEASE, chartSymbol: SYMBOL, bars: [], tickMs: 15 };
const orders = () => fake.calls.filter((c) => c.method === "POST" && c.path === "/accounts/auto/orders");
const arm = () => localStorage.setItem("drishti-autopaper-armed", "1");

test("off by default: a signal places nothing", async () => {
  const onEvent = mock((_m: string) => {});
  render(<AutoPaper {...props} signal={signal} onEvent={onEvent} />);
  await act(async () => await new Promise((r) => setTimeout(r, 80)));
  expect(orders()).toHaveLength(0);
  expect(screen.getByText(/Off: nothing is traded automatically/)).toBeTruthy();
});

test("armed, a fresh signal opens a paper futures order with the stop and TP2 held by the server, sized inside the cap", async () => {
  arm();
  const onEvent = mock((_m: string) => {});
  render(<AutoPaper {...props} signal={signal} onEvent={onEvent} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  expect(orders()).toHaveLength(1); // one order, however many ticks
  const b = orders()[0].body;
  expect(b).toMatchObject({ symbol: SYMBOL, side: "buy", stop: 288.2, target: 297.2, tag: "auto", strategy: "report-day", client_order_id: `auto-${RELEASE}`, r_points: 3 });
  expect(Number.isInteger(b.lots) && b.lots >= 1).toBe(true);
  expect(b.signal_time).toBe(new Date((CANDLE + 300) * 1000).toISOString());
  expect(onEvent.mock.calls[0][0]).toMatch(/paper LONG opened/);
  expect(screen.getByText(/291\.30/)).toBeTruthy(); // the fill the server reported
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

test("a refused order is recorded with the reason and not retried", async () => {
  arm();
  fake.order = { ok: false, status: 422, error: "the market is closed" };
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-skipped").textContent).toMatch(/the market is closed/));
  await act(async () => await new Promise((r) => setTimeout(r, 80)));
  expect(orders()).toHaveLength(1);
});

test("an R too wide for one lot inside the cap is skipped with that reason", async () => {
  arm();
  render(<AutoPaper {...props} signal={{ ...signal, rPoints: 20 }} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-skipped").textContent).toMatch(/over the .*2,000 cap/));
  expect(orders()).toHaveLength(0);
});

test("at TP1 the stop is moved to the entry, only tightening", async () => {
  arm();
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  act(() => useStore.setState({ quotes: { [SYMBOL]: { symbol: SYMBOL, price: 294.5, bid: 294.4, ask: 294.5, time: Date.now(), source: "upstox" } as never } }));
  await waitFor(() => expect(fake.calls.some((c) => c.method === "PATCH")).toBe(true));
  expect(fake.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ stop: 291.3, only_tighten: true });
  await waitFor(() => expect(screen.getByText(/Stop 291\.30 \(moved\)/)).toBeTruthy());
  const patches = fake.calls.filter((c) => c.method === "PATCH").length;
  await act(async () => await new Promise((r) => setTimeout(r, 80)));
  expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(patches); // not moved again
});

test("the time exit closes the trade at the market", async () => {
  arm();
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  act(() => setSystemTime(new Date(RELEASE + 91 * 60_000)));
  await waitFor(() => expect(screen.getByTestId("auto-closed").textContent).toMatch(/time exit/));
  expect(fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/close"))).toBe(true);
  expect(screen.getByTestId("auto-closed").textContent).toMatch(/net .*120/);
});

test("a stop or target that fired on the server is noticed and recorded", async () => {
  arm();
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  fake.open = false;
  fake.trade = { id: "p1", closedAt: Date.now(), exit: 288.2, net: -950, reason: "stop" };
  await waitFor(() => expect(screen.getByTestId("auto-closed").textContent).toMatch(/stopped out/));
  expect(screen.getByTestId("auto-closed").textContent).toMatch(/950/);
});

test("a reload carries on: the record is read back and nothing is placed twice", async () => {
  arm();
  const first = render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("auto-open")).toBeTruthy());
  first.unmount();
  render(<AutoPaper {...props} signal={signal} onEvent={() => {}} />);
  await act(async () => await new Promise((r) => setTimeout(r, 80)));
  expect(orders()).toHaveLength(1);
  expect(screen.getByTestId("auto-open")).toBeTruthy();
});
