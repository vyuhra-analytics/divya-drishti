import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TimeProfileView } from "./TimeProfileView";
import { BacktestWidget } from "./BacktestPanel";
import type { Widget } from "./workspace";

const win = (window: string, label: string, killzone: boolean, bar: number, over: object = {}) => ({ window, label, killzone, days: 40, avgRange: 130.4, avgRangePct: 1.5, avgBarRangePct: bar, volumePerMin: 50, spreadRows: 1000, spreadPct: 0.021, ...over });
const profile = {
  underlying: "CRUDEOILM",
  from: "2026-08-28",
  to: "2026-10-27",
  days: 42,
  spreadDays: 2,
  windows: [win("london", "London", true, 0.06), win("lclose", "London close", true, 0.0842), win("lunch", "New York lunch", false, 0.0799), win("overnight", "Overnight", false, 0.037, { spreadPct: undefined, spreadRows: 0 })],
  recent: [
    { day: "2026-10-27", window: "lclose", label: "London close", killzone: true, high: 9310, low: 9250, range: 60, average: 9280.4, volume: 1000, bars: 120 },
    { day: "2026-10-27", window: "lunch", label: "New York lunch", killzone: false, high: 9300, low: 9270, range: 30, average: 9285.2, volume: 800, bars: 90 },
  ],
};

const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  globalThis.fetch = mock(async (u: string) => (urls.push(String(u)), { ok: true, status: 200, json: async () => profile })) as never;
});
afterEach(cleanup);

test("names every window, flags the killzones, marks the busiest and compares killzones with the gaps", async () => {
  render(<TimeProfileView />);
  expect(await screen.findByText(/Busiest window: London close/)).toBeTruthy();
  expect(urls[0]).toContain("/research/time-profile?underlying=CRUDEOILM&days=60&recent=3");
  const rows = Array.from(document.querySelectorAll(".ef-table")[0].querySelectorAll("tbody tr"));
  expect(rows).toHaveLength(4);
  expect(rows[1].className).toBe("next"); // London close is the busiest
  expect(rows[0].textContent).toContain("killzone");
  expect(rows[2].textContent).not.toContain("killzone");
  expect(rows[3].textContent).toContain("—"); // no spread recorded for that window
  // killzones (0.06 and 0.0842, mean 0.0721) against the gaps (0.0799 and 0.037, mean 0.0585 = 0.058 shown)
  expect(screen.getByText(/killzones 0\.072%, the gaps between them 0\.058%/)).toBeTruthy();
  expect(screen.getByText(/The killzones are busier\./)).toBeTruthy();
});

test("shows each window of the latest days with its high, low, range and average", async () => {
  render(<TimeProfileView />);
  await screen.findByText(/Busiest window/);
  const rows = Array.from(document.querySelectorAll(".ef-table")[1].querySelectorAll("tbody tr"));
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("2026-10-27");
  expect(rows[0].textContent).toContain("9310.0");
  expect(rows[0].textContent).toContain("9250.0");
  expect(rows[0].textContent).toContain("60.0");
  expect(rows[0].textContent).toContain("9280.4");
  expect(rows[1].textContent).not.toContain("2026-10-27"); // the day is written once
});

test("says when the gaps are busier than the killzones", async () => {
  globalThis.fetch = mock(async () => ({ ok: true, status: 200, json: async () => ({ ...profile, windows: [win("london", "London", true, 0.03), win("lunch", "New York lunch", false, 0.08)] }) })) as never;
  render(<TimeProfileView />);
  expect(await screen.findByText(/the killzone labels do not mark the busiest hours here/)).toBeTruthy();
});

test("another contract or period asks for it; an error and an empty answer are said", async () => {
  render(<TimeProfileView />);
  await screen.findByText(/Busiest window/);
  fireEvent.change(screen.getByLabelText("Contract"), { target: { value: "NATGASMINI" } });
  await waitFor(() => expect(urls.some((u) => u.includes("underlying=NATGASMINI"))).toBe(true));
  fireEvent.change(screen.getByLabelText(/Last/), { target: { value: "90" } });
  await waitFor(() => expect(urls.some((u) => u.includes("days=90"))).toBe(true));
  cleanup();
  globalThis.fetch = mock(async () => ({ ok: false, status: 400, json: async () => ({ message: "days must be 5 to 180" }) })) as never;
  render(<TimeProfileView />);
  expect(await screen.findByText("days must be 5 to 180")).toBeTruthy();
  cleanup();
  globalThis.fetch = mock(async () => ({ ok: true, status: 200, json: async () => ({ ...profile, windows: [], recent: [] }) })) as never;
  render(<TimeProfileView />);
  expect(await screen.findByText(/No one-minute candles stored/)).toBeTruthy();
});

test("the Strategy tester panel has a Time of day tab", async () => {
  const widget = { id: "bt", type: "backtest", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
  render(<BacktestWidget widget={widget} />);
  fireEvent.click(screen.getByText("Time of day"));
  expect(await screen.findByText(/Busiest window/)).toBeTruthy();
});
