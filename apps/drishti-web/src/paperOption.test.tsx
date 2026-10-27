import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UPSTOX_MCX_RATES } from "@drishti/shared";
import { PaperWidget } from "./PaperPanel";
import { useStore } from "./store";
import type { Widget } from "./workspace";

const widget = { id: "pt", type: "paper", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
const leg = (delta: number, ask: number, ukey: string) => ({ key: "k", ukey, ask, bid: ask - 1, ltp: ask, delta, theta: -5, iv: 40, oi: 1000, volume: 50 });
const chain = { underlying: "CRUDEOIL", expiry: "2026-11-17", expiries: ["2026-11-17", "2026-12-16"], atm: 9600, lot: 100, updatedAt: Date.now(), rows: [[9550, 0.57, 200], [9600, 0.52, 170], [9650, 0.46, 140]].map(([strike, d, ask]) => ({ strike, ce: leg(d, ask, `MCX_FO|${strike}C`), pe: leg(-d, ask + 3, `MCX_FO|${strike}P`) })) };
const optionPosition = { id: "o1", symbol: "MCX_FO|9600P", side: "buy", lots: 1, units: 100, entry: 173.1, openedAt: 1, actor: "ui", stop: 120, option: { key: "MCX_FO|9600P", label: "CRUDEOIL 9600 PE 17 NOV 26", underlying: "CRUDEOIL", type: "PE", strike: 9600, expiry: "2026-11-17", tick: 0.1 } };

let server: { positions: any[]; trades: any[] };
const calls: { path: string; method: string; body?: any }[] = [];

beforeEach(() => {
  setSystemTime(new Date("2026-10-21T08:00:00Z"));
  localStorage.clear();
  calls.length = 0;
  server = { positions: [], trades: [] };
  useStore.setState({ quotes: {}, options: {}, paperRev: 0 });
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (u.includes("/options?")) return json(chain);
    const path = u.replace(/^.*\/paper/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/accounts" && method === "GET") return json({ accounts: [{ id: "main", capital: 500_000, slippage: 1 }] });
    if (/^\/accounts\/[^/]+$/.test(path) && method === "GET") {
      const realised = server.trades.reduce((s, t) => s + t.net, 0);
      return json({ state: { account: { id: "main", capital: 500_000, slippage: 1 }, positions: server.positions, trades: server.trades, rates: UPSTOX_MCX_RATES, limits: { maxLots: 2 }, summary: { realised, unrealised: 0, equity: 500_000 + realised, costsPaid: 0, trades: server.trades.length, winRate: 0, maxDrawdown: 0 } } });
    }
    if (path.endsWith("/orders") && method === "POST") {
      server.positions = [{ ...optionPosition, lots: body.lots, ...(body.stop ? { stop: body.stop } : {}) }];
      return json({ position: server.positions[0] }, 201);
    }
    return json({ error: `unexpected ${method} ${path}` }, 404);
  }) as never;
});
afterEach(() => {
  cleanup();
  setSystemTime();
});

test("the options ticket lists the strikes of the live chain with premium and delta and buys the chosen put at the ask, with a premium stop", async () => {
  render(<PaperWidget widget={widget} />);
  fireEvent.click(await screen.findByText("Options (buy)"));
  const strikeSelect = (await screen.findByLabelText("Strike")) as HTMLSelectElement;
  await waitFor(() => expect(strikeSelect.options.length).toBe(3));
  expect(strikeSelect.textContent).toContain("9600 ATM · 170.0 · δ 0.52");
  fireEvent.change(screen.getByLabelText("Call or put"), { target: { value: "PE" } });
  fireEvent.change(screen.getByLabelText("Strike"), { target: { value: "9600" } });
  fireEvent.change(screen.getByLabelText(/Stop \(premium/), { target: { value: "120" } });
  const buy = await screen.findByText(/Buy 1 lot CRUDEOIL 9600 PE 2026-11-17 at the ask \(173\.0\)/);
  fireEvent.click(buy);
  const post = await waitFor(() => calls.find((c) => c.path.endsWith("/orders"))!);
  expect(post.body).toEqual({ option: { key: "MCX_FO|9600P" }, side: "buy", lots: 1, stop: 120 });
  expect(await screen.findByText("CRUDEOIL 9600 PE 17 NOV 26")).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Bought" })).toBeTruthy();
});

test("a live option quote under ten seconds old is the premium shown for the ticket", async () => {
  act(() => void useStore.setState({ options: { "MCX_FO|9600C": { key: "MCX_FO|9600C", price: 175, ask: 176.5, bid: 175.5, time: Date.now(), recvAt: Date.now() } as never } }));
  render(<PaperWidget widget={widget} />);
  fireEvent.click(await screen.findByText("Options (buy)"));
  expect(await screen.findByText(/Buy 1 lot CRUDEOIL 9600 CE 2026-11-17 at the ask \(176\.5\)/)).toBeTruthy();
  expect(screen.getAllByText(/live quote/).length).toBeGreaterThan(0);
});

test("an open option position shows its name, the live premium and the P&L marked at the option's bid", async () => {
  server.positions = [optionPosition];
  act(() => void useStore.setState({ options: { "MCX_FO|9600P": { key: "MCX_FO|9600P", price: 200, ask: 201, bid: 199, time: Date.now(), recvAt: Date.now() } as never } }));
  render(<PaperWidget widget={widget} />);
  expect(await screen.findByText("CRUDEOIL 9600 PE 17 NOV 26")).toBeTruthy();
  const row = screen.getByText("CRUDEOIL 9600 PE 17 NOV 26").closest("tr")!;
  expect(row.textContent).toContain("Bought");
  expect(row.textContent).toContain("200.00"); // the premium now
  expect(row.textContent).toContain("bid 199.00");
  expect(row.querySelector(".up")).toBeTruthy(); // 199 - 0.1 slippage vs 173.1 paid: a gain even after the option costs
});

test("an option trade in the journal reads as bought, with the option's name", async () => {
  server.trades = [{ id: "t1", symbol: "MCX_FO|9600P", side: "buy", lots: 1, units: 100, entry: 173.1, exit: 210, openedAt: 1, closedAt: 2, gross: 3690, costs: 120, net: 3570, reason: "manual", note: "", actor: "ui", closedBy: "ui", option: optionPosition.option }];
  render(<PaperWidget widget={widget} />);
  const cell = await screen.findByText(/CRUDEOIL 9600 PE 17 NOV 26 bought 1×/);
  expect(cell.textContent).toContain("173.10→210.00");
});

test("the futures ticket is still there", async () => {
  render(<PaperWidget widget={widget} />);
  expect(await screen.findByText(/Buy 1 lot Crude Oil at market/)).toBeTruthy();
});
