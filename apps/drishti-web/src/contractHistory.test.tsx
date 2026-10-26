import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bucketStart } from "@drishti/shared";
import { ContractHistoryWidget } from "./ContractHistoryPanel";
import { useStore } from "./store";
import type { Widget } from "./workspace";

const widget = { id: "oh", type: "optionhistory", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const contracts = [
  { key: "MCX_FO|1", symbol: "CRUDEOIL FUT", expiry: future, strike: 0, side: "FUT", lot: 100 },
  { key: "MCX_FO|2", symbol: "CRUDEOIL 9500 CE", expiry: future, strike: 9500, side: "CE", lot: 100 },
  { key: "MCX_FO|3", symbol: "CRUDEOIL 9600 CE", expiry: future, strike: 9600, side: "CE", lot: 100 },
  { key: "MCX_FO|4", symbol: "CRUDEOIL 9600 CE OLD", expiry: "2026-09-17", strike: 9600, side: "CE", lot: 100 },
];
// two sessions of one-minute candles, 21:00 IST on two consecutive days
const session = (day: string, base: number) => Array.from({ length: 10 }, (_, i) => ({ time: Date.parse(`${day}T21:${String(i).padStart(2, "0")}:00+05:30`) / 1000, open: base + i, high: base + i + 2, low: base + i - 1, close: base + i + 1, volume: 10 + i, oi: 1000 + i }));
const candles = [...session("2026-10-23", 500), ...session("2026-10-26", 520)];

const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  useStore.setState({ quotes: {} });
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    if (String(url).includes("/feed/contracts")) return { ok: true, status: 200, json: async () => contracts };
    if (String(url).includes("/option-candles")) return { ok: true, status: 200, json: async () => candles };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as never;
});
afterEach(cleanup);

test("lists the recorded contracts, defaults to the nearest live expiry and draws price, open interest and volume with a readout of the last candle", async () => {
  render(<ContractHistoryWidget widget={widget} />);
  expect(await screen.findByRole("img", { name: /CRUDEOIL 9\d00 CE: price from/ })).toBeTruthy();
  expect(urls.some((u) => u.includes("/feed/contracts?underlying=CRUDEOIL"))).toBe(true);
  expect(urls.some((u) => u.includes("/option-candles?key=MCX_FO%7C"))).toBe(true);
  const expiry = screen.getByLabelText("Expiry") as HTMLSelectElement;
  expect(expiry.value).toBe(future); // not the expired one
  expect(Array.from(expiry.options).map((o) => o.textContent)).toContain("2026-09-17 (expired)");
  expect(document.querySelectorAll("rect.ch-vol").length).toBeGreaterThan(0);
  expect(document.querySelector("path.ch-oi")).toBeTruthy();
  expect(document.querySelector(".ch-read")!.textContent).toMatch(/OI 1,009/); // the last candle's open interest
});

test("the resolution and the number of sessions change what is drawn, and a hover moves the readout", async () => {
  render(<ContractHistoryWidget widget={widget} />);
  const chart = await screen.findByRole("img");
  const count = () => document.querySelectorAll("rect.ch-vol").length;
  fireEvent.change(screen.getByLabelText("Sessions"), { target: { value: "1" } });
  const oneSession = count();
  fireEvent.change(screen.getByLabelText("Sessions"), { target: { value: "3" } });
  const fiveMinutes = count();
  expect(fiveMinutes).toBeGreaterThan(oneSession);
  fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "1h" } });
  expect(count()).toBeLessThan(fiveMinutes); // ten one-minute candles of an hour collapse into one per session
  fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "1m" } });
  chart.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.mouseMove(chart, { clientX: 0 });
  expect(document.querySelector(".ch-read")!.textContent).toMatch(/OI 1,000/); // the first candle
  expect(document.querySelector("line.ch-cross")).toBeTruthy();
  fireEvent.mouseLeave(chart);
  expect(document.querySelector("line.ch-cross")).toBeNull();
});

test("choosing the future drops the strike list and loads that contract", async () => {
  render(<ContractHistoryWidget widget={widget} />);
  await screen.findByRole("img");
  fireEvent.click(screen.getByText("Future"));
  await waitFor(() => expect(urls.some((u) => u.includes("key=MCX_FO%7C1&"))).toBe(true));
  expect(screen.queryByLabelText("Strike")).toBeNull();
});

test("says so when nothing is recorded, when the route fails and for an instrument that is not MCX", async () => {
  globalThis.fetch = mock(async (url: string) => (String(url).includes("/feed/contracts") ? { ok: true, status: 200, json: async () => [] } : { ok: true, status: 200, json: async () => [] })) as never;
  render(<ContractHistoryWidget widget={widget} />);
  expect(await screen.findByText(/Nothing recorded yet for CRUDEOIL/)).toBeTruthy();
  cleanup();
  globalThis.fetch = mock(async (url: string) =>
    String(url).includes("/feed/contracts") ? { ok: true, status: 200, json: async () => contracts } : { ok: false, status: 400, json: async () => ({ message: "at most 40 days at a time" }) },
  ) as never;
  render(<ContractHistoryWidget widget={widget} />);
  expect(await screen.findByText("at most 40 days at a time")).toBeTruthy();
  cleanup();
  render(<ContractHistoryWidget widget={{ ...widget, symbol: "NYMEX:CL" }} />);
  expect(screen.getByText(/recorded for the MCX contracts only/)).toBeTruthy();
});

test("draws the estimated delta and book imbalance under the candles, labels them as estimates, and puts them in the readout", async () => {
  const buckets = [...new Set(candles.map((c) => bucketStart(c.time, 300, 19_800)))].map((time, i) => ({ time, buy: 10, sell: 4, unclassified: 0, volume: 14, delta: i % 2 ? -6 : 6, cumDelta: 0, imbalance: i % 2 ? -0.25 : 0.4, spread: 1.5, msgs: 200 }));
  const base = globalThis.fetch as unknown as (u: string) => Promise<unknown>;
  globalThis.fetch = mock(async (url: string) => {
    if (String(url).includes("/feed/flow")) {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ estimated: true, buckets }) };
    }
    return base(url);
  }) as never;
  render(<ContractHistoryWidget widget={widget} />);
  await screen.findByRole("img");
  await waitFor(() => expect(document.querySelectorAll("rect.ch-dpos, rect.ch-dneg").length).toBeGreaterThan(0));
  expect(document.querySelectorAll("rect.ch-dpos").length).toBeGreaterThan(0);
  expect(document.querySelectorAll("rect.ch-dneg").length).toBeGreaterThan(0);
  expect(document.querySelector("path.ch-imb")).toBeTruthy();
  expect(urls.some((u) => u.includes("/feed/flow?key=MCX_FO%7C") && u.includes("&tf=5m"))).toBe(true);
  expect(document.querySelector(".ch-read")!.textContent).toMatch(/Δ [+-]\d+ \(est\.\) · book [+-]0\.\d+ · spread 1\.50/);
  expect(screen.getByText(/Delta and book are estimates/)).toBeTruthy();
});

test("says so when the contract has no tick-level recording, and the rest of the chart still draws", async () => {
  render(<ContractHistoryWidget widget={widget} />); // the default mock answers 404 for /feed/flow
  await screen.findByRole("img");
  expect(await screen.findByText(/No order flow for this contract/)).toBeTruthy();
  expect(document.querySelector("path.ch-price")).toBeTruthy();
  expect(document.querySelectorAll("rect.ch-dpos, rect.ch-dneg")).toHaveLength(0);
});
