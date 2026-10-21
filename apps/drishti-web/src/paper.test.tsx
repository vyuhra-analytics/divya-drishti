import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UPSTOX_MCX_RATES } from "@drishti/shared";
import { PaperWidget } from "./PaperPanel";
import { useStore } from "./store";
import type { Widget } from "./workspace";

const SYM = "MCX:CRUDEOIL";
const widget = { id: "pt", type: "paper", group: null, symbol: SYM, tf: "5m" } as Widget;
const quote = (price: number) => ({ symbol: SYM, price, bid: price - 1, ask: price + 1, time: Date.now(), delayedBy: 0, source: "upstox" }) as never;
const feed = (price: number) => useStore.setState({ quotes: { [SYM]: quote(price) }, seen: { [SYM]: Date.now() } });

/** a stand-in for the stream's /paper API: tests change `server` the way an agent over MCP changes the real one */
let server: { account: any; positions: any[]; trades: any[]; accounts: any[]; fail?: { status: number; error: string } };
const calls: { path: string; method: string; body?: any }[] = [];
const summary = () => ({ realised: server.trades.reduce((s, t) => s + t.net, 0), unrealised: 0, equity: 0, costsPaid: server.trades.reduce((s, t) => s + t.costs, 0), trades: server.trades.length, winRate: 0, maxDrawdown: 0 });

beforeEach(() => {
  setSystemTime(new Date("2026-10-21T08:00:00Z")); // Wednesday 13:30 IST: MCX open
  localStorage.clear();
  calls.length = 0;
  server = { account: { id: "main", capital: 500_000, slippage: 1 }, positions: [], trades: [], accounts: [{ id: "main", capital: 500_000, slippage: 1 }] };
  feed(9400);
  useStore.setState({ paperRev: 0 });
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/paper/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (server.fail) return json({ error: server.fail.error }, server.fail.status);
    if (path === "/accounts" && method === "GET") return json({ accounts: server.accounts });
    if (/^\/accounts\/[^/]+$/.test(path) && method === "GET") return json({ state: { account: server.account, positions: server.positions, trades: server.trades, rates: UPSTOX_MCX_RATES, limits: { maxLots: 100, maxOpenPositions: 8, maxOrdersPerDay: 500 }, summary: summary() } });
    if (path.endsWith("/orders") && method === "POST") {
      const p = { id: "p1", symbol: body.symbol, side: body.side, lots: body.lots, units: 100, entry: 9402, openedAt: Date.now(), actor: "ui", ...(body.stop ? { stop: body.stop } : {}) };
      server.positions = [p];
      return json({ position: p }, 201);
    }
    if (path.endsWith("/close") && method === "POST") {
      const p = server.positions[0];
      server.positions = [];
      server.trades = [{ id: p.id, symbol: p.symbol, side: p.side, lots: p.lots, units: 100, entry: p.entry, exit: 9418, openedAt: p.openedAt, closedAt: Date.now(), gross: 1600, costs: 210, net: 1390, reason: "manual", note: "", actor: p.actor, closedBy: "ui" }];
      return json({ trade: server.trades[0] });
    }
    if (path.includes("/note") && method === "PUT") {
      server.trades[0].note = body.note;
      return json({});
    }
    if (path.endsWith("/import") && method === "POST") return json({ positions: 0, trades: 2 });
    return json({ error: `unexpected ${method} ${path}` }, 404);
  }) as never;
});
afterEach(() => {
  cleanup();
  setSystemTime();
});

test("the panel shows the server account and places an order through the API", async () => {
  render(<PaperWidget widget={widget} />);
  fireEvent.click(await screen.findByText(/Buy 1 lot Crude Oil at market/));
  const post = await waitFor(() => calls.find((c) => c.path.endsWith("/orders"))!);
  expect(post.body).toEqual({ symbol: SYM, side: "buy", lots: 1 });
  expect(await screen.findByRole("cell", { name: /^Long$/ })).toBeTruthy();
});

test("a trade an agent places over MCX appears in the panel when the stream announces it, tagged as Claude's", async () => {
  render(<PaperWidget widget={widget} />);
  await screen.findByText("None."); // no open positions yet
  // Claude places a trade on the server; the stream tells open browsers
  server.positions = [{ id: "mcp1", symbol: SYM, side: "sell", lots: 2, units: 100, entry: 9398, openedAt: Date.now(), actor: "mcp" }];
  act(() => useStore.setState((s) => ({ paperRev: s.paperRev + 1 })));
  expect(await screen.findByRole("cell", { name: /^Short$/ })).toBeTruthy();
  expect(screen.getByText("Claude (MCP)")).toBeTruthy();
  // then Claude closes it: the journal shows who opened and closed it
  server.positions = [];
  server.trades = [{ id: "mcp1", symbol: SYM, side: "sell", lots: 2, units: 100, entry: 9398, exit: 9380, openedAt: 1, closedAt: Date.now(), gross: 3600, costs: 300, net: 3300, reason: "manual", note: "", actor: "mcp", closedBy: "mcp" }];
  act(() => useStore.setState((s) => ({ paperRev: s.paperRev + 1 })));
  expect(await screen.findByText(/opened by Claude/)).toBeTruthy();
  expect(screen.getByText(/closed by Claude/)).toBeTruthy();
  expect(screen.queryByText("Closed by hand")).toBeNull(); // Claude closed it, not you
});

test("closing and journal notes go through the API; a note is saved when the field loses focus", async () => {
  server.positions = [{ id: "p1", symbol: SYM, side: "buy", lots: 1, units: 100, entry: 9402, openedAt: 1, actor: "ui" }];
  render(<PaperWidget widget={widget} />);
  fireEvent.click(await screen.findByText("Close"));
  const note = (await screen.findByLabelText(`Note for the ${SYM} trade`)) as HTMLInputElement;
  fireEvent.change(note, { target: { value: "followed the plan" } });
  fireEvent.blur(note);
  await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path.includes("/note"))?.body).toEqual({ note: "followed the plan" }));
});

test("without the database the panel says so instead of showing an empty account", async () => {
  server.fail = { status: 500, error: "relation paper_accounts does not exist" };
  render(<PaperWidget widget={widget} />);
  expect(await screen.findByText(/Paper trading needs the database/)).toBeTruthy();
});

test("an order the server refuses (agent caps, closed market) shows the reason", async () => {
  render(<PaperWidget widget={widget} />);
  const orig = globalThis.fetch;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => (String(url).endsWith("/orders") ? { ok: false, status: 503, json: async () => ({ error: "the market is closed or the feed is stale: paper orders fill only on a live price" }) } : (orig as any)(url, init))) as never;
  fireEvent.click(await screen.findByText(/Buy 1 lot Crude Oil at market/));
  expect(await screen.findByText(/market is closed or the feed is stale/)).toBeTruthy();
});

test("the account this browser kept before the server existed is imported once into the empty server account", async () => {
  localStorage.setItem("drishti-paper", JSON.stringify({ state: { capital: 500_000, slippage: 1, positions: [], trades: [{ id: "t1" }, { id: "t2" }] }, version: 1 }));
  render(<PaperWidget widget={widget} />);
  expect(await screen.findByText(/Imported 2 trades/)).toBeTruthy();
  expect(calls.filter((c) => c.path.endsWith("/import"))).toHaveLength(1);
  expect(localStorage.getItem("drishti-paper-imported")).toBe("1");
  cleanup();
  render(<PaperWidget widget={widget} />);
  await screen.findByText("None.");
  expect(calls.filter((c) => c.path.endsWith("/import"))).toHaveLength(1); // never twice
});
