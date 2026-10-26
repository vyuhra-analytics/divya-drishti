import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QualityWidget } from "./QualityPanel";
import type { Widget } from "./workspace";

const widget = { id: "dq", type: "quality", group: null } as Widget;

beforeEach(() => {
  const now = Date.now();
  const health = {
    providers: {
      upstox: { ok: 100, failed: 0, lastError: null, lastOkAt: now - 1000, latencyMs: null },
      yahoo: { ok: 5, failed: 3, lastError: "HTTP 429", lastOkAt: now - 10 * 60_000, latencyMs: 120 },
    },
    active: { "MCX:CRUDEOIL": "upstox" },
    prices: {
      "MCX:CRUDEOIL": { upstox: { price: 9483, at: now - 500 }, tradingview: { price: 9486, at: now - 800 } },
      "MCX:NATURALGAS": { upstox: { price: 272, at: now - 500 }, tradingview: { price: 250, at: now - 800 } }, // far apart
    },
    rejected: { count: 2, last: { symbol: "MCX:CRUDEOIL", source: "tradingview", reason: "price is not a positive number", at: now } },
    recorder: { on: true, rows: 12345, failedInserts: 2, dropped: 0, contracts: 304, lastRowAt: now - 3000 },
    capture: { snapshots: 7, lastSnapshotAt: now - 4 * 60_000, lastSnapshotRows: 2908, contractsKnown: 2908 },
  };
  const feedStatus = {
    feedQuotes: { rows: "78502", keys: 308, first: null, last: null },
    quoteSnapshots: { rows: "20356", keys: 2908, snapshots: 7, last: null },
    size: { feed_quotes: "52 MB", quote_snapshots: "3 MB" },
  };
  const day = Date.parse("2026-10-26T09:00:00+05:30");
  const coverage = { window: { from: day, to: day + 600_000, official: true }, expectedMinutes: 870, coveredMinutes: 700, ratio: 700 / 870, gaps: [{ from: day, to: day + 120_000, minutes: 2 }] };
  const canaries = {
    canaries: [
      { id: "cftc-cot", status: "ok", at: now - 60_000, ms: 900, recent: [{ at: now - 60_000, status: "ok" }] },
      { id: "yahoo-chart", status: "format", at: now - 120_000, ms: 5000, detail: "expected 20+ consistent 5m bars", recent: [{ at: now - 120_000, status: "format" }] },
      { id: "eia-v2-stocks", status: "skipped", at: now, ms: 0, detail: "set EIA_API_KEY", recent: [{ at: now, status: "skipped" }] },
    ],
    sources: [],
  };
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    const body = u.includes("/canaries") ? canaries : u.includes("/feed/status") ? feedStatus : u.includes("/feed/coverage") ? coverage : u.includes("/health") ? health : null;
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  }) as never;
});
afterEach(cleanup);

test("shows feed health, price agreement with a drift flag, and source checks with failures first", async () => {
  render(<QualityWidget widget={widget} />);
  expect(await screen.findByText("upstox")).toBeTruthy();
  expect(screen.getByText("live")).toBeTruthy(); // upstox heard from a second ago
  expect(screen.getByText("silent")).toBeTruthy(); // yahoo not for 10 minutes
  expect(screen.getByText("HTTP 429")).toBeTruthy();
  expect(screen.getByText(/2 impossible quote\(s\) rejected/)).toBeTruthy();

  // crude agrees (3 ticks), gas has drifted
  await waitFor(() => expect(screen.getAllByText("agree").length).toBe(1));
  expect(screen.getByText("DRIFTING")).toBeTruthy();
  expect(screen.getByText(/upstox 9483 \(shown\)/)).toBeTruthy();

  await screen.findByText("yahoo-chart");
  expect(screen.getByText(/FORMAT CHANGED/)).toBeTruthy();
  expect(screen.getByText(/expected 20\+ consistent 5m bars/)).toBeTruthy();
  expect(screen.getByText(/SKIPPED/)).toBeTruthy();
  const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
  const idx = (id: string) => rows.findIndex((r) => r.startsWith(id));
  expect(idx("yahoo-chart")).toBeLessThan(idx("cftc-cot")); // the failing source is listed before the healthy one
});

test("says so when the stream is unreachable", async () => {
  globalThis.fetch = mock(async () => ({ ok: false, status: 500, json: async () => ({}) })) as never;
  render(<QualityWidget widget={widget} />);
  expect(await screen.findByText(/Stream service unreachable/)).toBeTruthy();
});

test("shows what is being recorded: rows, failed inserts, snapshots, database size and today's coverage with its holes", async () => {
  render(<QualityWidget widget={widget} />);
  expect(await screen.findByText("Recording (what we keep from Upstox)")).toBeTruthy();
  expect(screen.getByText(/12,345 stored, 2 failed insert\(s\)/)).toBeTruthy();
  expect(screen.getByText(/304 contracts watched/)).toBeTruthy();
  expect(screen.getByText(/7 since start/)).toBeTruthy();
  expect(screen.getByText(/2,908 contracts/)).toBeTruthy();
  await waitFor(() => expect(screen.getByText(/78,502 feed rows \(52 MB\)/)).toBeTruthy());
  await waitFor(() => expect(screen.getByText(/80\.5% · 700 of 870 session minutes/)).toBeTruthy());
  expect(screen.getByText("1 gap")).toBeTruthy();
  expect(screen.getByText(/Holes in today's recording/)).toBeTruthy();
});

test("a stream with the recorder off draws no recording section", async () => {
  const base = globalThis.fetch as unknown as (u: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
  globalThis.fetch = mock(async (u: string) => {
    const r = await base(u);
    if (!String(u).includes("/health")) return r;
    const j = await r.json();
    return { ...r, json: async () => ({ ...j, recorder: { on: false }, capture: null }) };
  }) as never;
  render(<QualityWidget widget={widget} />);
  await screen.findByText("upstox");
  expect(screen.queryByText("Recording (what we keep from Upstox)")).toBeNull();
});
