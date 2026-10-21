import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
