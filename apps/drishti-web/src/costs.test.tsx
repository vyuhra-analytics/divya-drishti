import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CostsWidget } from "./CostsPanel";
import { useStore } from "./store";
import type { Widget } from "./workspace";

const widget = (symbol: string) => ({ id: "c", type: "costs", group: null, symbol, tf: "5m" }) as Widget;

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ quotes: { "MCX:CRUDEOIL": { symbol: "MCX:CRUDEOIL", price: 9400, prevClose: 9300, time: Date.now(), delayedBy: 0, source: "upstox" } as never } });
});
afterEach(cleanup);

test("shows the gross-to-net bridge and a position size for an MCX contract from its live price", () => {
  render(<CostsWidget widget={widget("MCX:CRUDEOIL")} />);
  expect(screen.getByText(/1 lot = 100 bbl/)).toBeTruthy();
  expect(screen.getByText("Gross P&L")).toBeTruthy();
  expect(screen.getByText("− CTT")).toBeTruthy();
  expect(screen.getByText("Net P&L")).toBeTruthy();
  // default entry 9400, stop 0.5% below: 47 points × 100 = ₹4,700 a lot, so a 1% risk on ₹5 lakh (₹5,000) fits one lot
  expect(screen.getByText("1").tagName).toBe("STRONG");
});

test("the lot count follows the risk setting", () => {
  render(<CostsWidget widget={widget("MCX:CRUDEOIL")} />);
  fireEvent.change(screen.getByLabelText("Risk per trade (%)"), { target: { value: "0.1" } });
  expect(screen.getByText(/even one lot exceeds the budget/)).toBeTruthy();
});

test("NYMEX contracts get a note instead of costs", () => {
  render(<CostsWidget widget={widget("NYMEX:CL")} />);
  expect(screen.getByText(/NYMEX trades are not on Upstox/)).toBeTruthy();
});

test("the saved rates of an untouched old table take the new Rs 30 brokerage; an edited table is kept", () => {
  const old = { brokerageFlat: 20, cttFutures: 0.0001, cttOptions: 0.0005, exchangeFutures: 0.000021, exchangeOptions: 0.000418, sebi: 0.000001, stampFutures: 0.00002, stampOptions: 0.00003, gst: 0.18 };
  localStorage.setItem("drishti-costs", JSON.stringify({ rates: old, equity: 500_000, riskPct: 1 }));
  render(<CostsWidget widget={widget("MCX:CRUDEOIL")} />);
  expect((screen.getByLabelText("Brokerage per order (₹)") as HTMLInputElement).value).toBe("30");
  cleanup();
  localStorage.setItem("drishti-costs", JSON.stringify({ rates: { ...old, brokerageFlat: 25 }, equity: 500_000, riskPct: 1 }));
  render(<CostsWidget widget={widget("MCX:CRUDEOIL")} />);
  expect((screen.getByLabelText("Brokerage per order (₹)") as HTMLInputElement).value).toBe("25");
});

test("Check with Upstox shows Upstox's charge beside ours, and offers its brokerage when ours differs", async () => {
  localStorage.setItem("drishti-costs", JSON.stringify({ rates: { brokerageFlat: 20, cttFutures: 0.0001, cttOptions: 0.0005, exchangeFutures: 0.000021, exchangeOptions: 0.000418, sebi: 0.000001, stampFutures: 0.00002, stampOptions: 0.00003, gst: 0.19 }, equity: 500_000, riskPct: 1 }));
  const urls: string[] = [];
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ upstox: { total: 77.68, brokerage: 30 }, ours: {}, diff: 0, agree: true }) };
  }) as never;
  render(<CostsWidget widget={widget("MCX:CRUDEOIL")} />);
  fireEvent.click(screen.getByText("Check with Upstox"));
  await waitFor(() => expect(screen.getByText(/Upstox charges ₹77\.68 for this leg \(brokerage ₹30\)/)).toBeTruthy());
  expect(urls[0]).toContain("/costs/check?symbol=MCX%3ACRUDEOIL&kind=future&side=buy&price=9400&lots=1");
  expect(screen.getByText(/less than Upstox|more than Upstox/)).toBeTruthy();
  fireEvent.click(screen.getByText("Use ₹30 brokerage"));
  expect((screen.getByLabelText("Brokerage per order (₹)") as HTMLInputElement).value).toBe("30");
});

test("Check with Upstox says why when the API cannot ask Upstox", async () => {
  globalThis.fetch = mock(async () => ({ ok: false, status: 503, json: async () => ({ message: "Upstox not connected: set UPSTOX_ACCESS_TOKEN" }) })) as never;
  render(<CostsWidget widget={widget("MCX:CRUDEOIL")} />);
  fireEvent.click(screen.getByText("Check with Upstox"));
  await waitFor(() => expect(screen.getByText(/Upstox not connected/)).toBeTruthy());
});
