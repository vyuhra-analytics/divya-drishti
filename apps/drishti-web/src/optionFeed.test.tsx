import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Chain, OptionQuote } from "@drishti/shared";
import { LIVE_MAX_AGE_MS, overlayLive, watchKeys } from "./optionFeed";
import { OptionChainWidget } from "./OptionChainPanel";
import { connectStream, useStore } from "./store";
import type { Widget } from "./workspace";

const leg = (n: number, over: object = {}) => ({ key: `MCX:X${n}`, ukey: `MCX_FO|${100000 + n}`, ltp: 500, bid: 499, ask: 501, oi: 2000, volume: 1500, iv: 50, delta: 0.5, theta: -9, vega: 10, gamma: 0.001, ...over });
const strikes = Array.from({ length: 15 }, (_, i) => 9000 + i * 50); // 9000 … 9700
const chain = (over: Partial<Chain> = {}): Chain => ({
  underlying: "CRUDEOIL",
  expiry: "2026-11-17",
  expiries: ["2026-11-17"],
  spot: 9346,
  atm: 9350,
  updatedAt: 1,
  source: "combined",
  rows: strikes.map((strike, i) => ({ strike, ce: leg(i * 2), pe: leg(i * 2 + 1) })),
  ...over,
});
const quote = (key: string, over: Partial<OptionQuote> = {}): OptionQuote => ({ key, price: 512.34, time: Date.now() - 400, recvAt: Date.now(), bid: 512, ask: 512.7, oi: 2100, volume: 1600, iv: 52.19, delta: 0.4904, theta: -9.94, gamma: 0.0003, vega: 9.95, ...over });

test("watchKeys: the legs of the nine strikes nearest the money, none for a leg without an Upstox key", () => {
  const keys = watchKeys(chain());
  expect(keys).toHaveLength(18); // 9 strikes × call and put
  const atmRow = 7; // 9350
  expect(keys).toContain(`MCX_FO|${100000 + atmRow * 2}`);
  expect(keys).not.toContain(`MCX_FO|${100000}`); // 9000 is seven strikes away
  const noKeys = chain({ rows: chain().rows.map((r) => ({ ...r, ce: { ...r.ce!, ukey: undefined } })) });
  expect(watchKeys(noKeys)).toHaveLength(9); // only the puts have keys
  expect(watchKeys(null)).toEqual([]);
  expect(watchKeys(chain({ rows: [] }))).toEqual([]);
});

test("overlayLive: a fresh quote replaces the polled numbers, a stale one does not, and the summary counts only fresh legs", () => {
  const now = Date.now();
  const c = chain();
  const ce = c.rows[7].ce!.ukey!;
  const pe = c.rows[7].pe!.ukey!;
  const quotes = { [ce]: quote(ce, { recvAt: now - 500 }), [pe]: quote(pe, { recvAt: now - LIVE_MAX_AGE_MS - 1 }) };
  const { chain: out, live } = overlayLive(c, quotes, now);
  expect(out.rows[7].ce).toMatchObject({ ltp: 512.34, bid: 512, ask: 512.7, iv: 52.19, delta: 0.4904, oi: 2100, key: "MCX:X14", ukey: ce });
  expect(out.rows[7].pe!.ltp).toBe(500); // stale: the polled value stays
  expect(out.rows[6].ce!.ltp).toBe(500); // never asked about: untouched
  expect(live).toEqual({ watched: 18, fresh: 1, newestAgeMs: 500 });
  const none = overlayLive(c, {}, now);
  expect(none.chain).toBe(c); // no live quote: the same object comes back
  expect(none.live).toEqual({ watched: 18, fresh: 0, newestAgeMs: undefined });
});

test("a quote that lacks a field keeps the polled value for it (the polled greeks stay when the feed sends none)", () => {
  const now = Date.now();
  const c = chain();
  const ce = c.rows[7].ce!.ukey!;
  const { chain: out } = overlayLive(c, { [ce]: quote(ce, { recvAt: now, delta: undefined, bid: undefined }) }, now);
  expect(out.rows[7].ce).toMatchObject({ ltp: 512.34, delta: 0.5, bid: 499 });
});

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(m: string) {
    this.sent.push(m);
  }
  close() {}
}
const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as never;
  localStorage.clear();
  useStore.setState({ options: {} });
  globalThis.fetch = mock(async () => ({ ok: true, status: 200, json: async () => chain() })) as never;
});
afterEach(() => {
  cleanup();
  globalThis.WebSocket = realWebSocket;
});
const widget = { id: "ocx", type: "optionchain", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;

test("the chain panel asks the stream to watch the contracts around the money, and shows a live premium over the polled one", async () => {
  connectStream();
  const sock = FakeSocket.instances[0]!;
  sock.onopen?.();
  render(<OptionChainWidget widget={widget} />);
  await waitFor(() => expect(sock.sent.some((m) => m.startsWith('{"watch":'))).toBe(true));
  const watch = JSON.parse(sock.sent.find((m) => m.startsWith('{"watch":'))!).watch as string[];
  expect(watch).toHaveLength(18);
  expect(watch.every((k) => /^MCX_FO\|\d+$/.test(k))).toBe(true);
  expect(screen.queryByText(/live feed/)).toBeNull(); // nothing has arrived yet: polled
  // a live tick for the at-the-money call arrives over the socket
  const ce = chain().rows[7].ce!.ukey!;
  sock.onmessage?.({ data: JSON.stringify({ type: "opt", q: quote(ce) }) });
  await waitFor(() => expect(screen.getByText(/live feed 1\/18 contracts/)).toBeTruthy());
  expect(screen.getAllByText("512.34").length).toBeGreaterThan(0);
});

test("with the feed silent the panel says polled and shows the polled numbers", async () => {
  connectStream();
  FakeSocket.instances[0]!.onopen?.();
  const ce = chain().rows[7].ce!.ukey!;
  useStore.setState({ options: { [ce]: quote(ce, { recvAt: Date.now() - 60_000 }) } });
  render(<OptionChainWidget widget={widget} />);
  await waitFor(() => expect(screen.getByText("polled")).toBeTruthy());
  expect(screen.queryByText("512.34")).toBeNull();
});
