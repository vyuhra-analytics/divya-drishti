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
  };
  const canaries = {
    canaries: [
      { id: "cftc-cot", status: "ok", at: now - 60_000, ms: 900, recent: [{ at: now - 60_000, status: "ok" }] },
      { id: "yahoo-chart", status: "format", at: now - 120_000, ms: 5000, detail: "expected 20+ consistent 5m bars", recent: [{ at: now - 120_000, status: "format" }] },
      { id: "eia-v2-stocks", status: "skipped", at: now, ms: 0, detail: "set EIA_API_KEY", recent: [{ at: now, status: "skipped" }] },
    ],
    sources: [],
  };
  globalThis.fetch = mock(async (url: string) => {
    const body = String(url).includes("/canaries") ? canaries : String(url).includes("/health") ? health : null;
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
