import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FX_PAIRS, SYMBOLS, type FxRow, type Quote } from "@drishti/shared";
import { TickerTape } from "./TickerTape";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { useWorkspace } from "./workspace";

const quote = (symbol: string, price: number, prevClose: number, contract?: string): Quote => ({ symbol, price, prevClose, time: Date.now(), contract, source: "upstox", delayedBy: 0 });

beforeEach(() => {
  useSettings.setState({ tickerTape: true });
  useStore.setState({ quotes: { "MCX:CRUDEOIL": quote("MCX:CRUDEOIL", 9289, 9311, "CRUDEOIL FUT 19 NOV 26"), "NYMEX:CL": quote("NYMEX:CL", 97.5, 97) } });
});
afterEach(cleanup);

test("every tracked symbol appears with price, signed change, percent and expiry; the loop copy is hidden from assistive tech", () => {
  const { container } = render(<TickerTape />);
  const real = container.querySelectorAll(".tape-track > .tape-item");
  expect(real).toHaveLength(SYMBOLS.length + FX_PAIRS.length);
  expect(container.querySelectorAll(".tape-copy .tape-item")).toHaveLength(SYMBOLS.length + FX_PAIRS.length);
  expect(container.querySelector(".tape-copy")?.getAttribute("aria-hidden")).toBe("true");
  const crude = real[0]!.textContent!;
  expect(crude).toContain("CRUDEOIL");
  expect(crude).toContain("9,289");
  expect(crude).toMatch(/−22.*\(−0\.24%\)/);
  expect(crude).toContain("Exp. 19 Nov");
  expect(real[0]!.querySelector(".down")).not.toBeNull();
  const cl = [...real].find((r) => r.textContent!.includes("CL"))!;
  expect(cl.querySelector(".up")?.textContent).toMatch(/\+0\.5.*\(\+0\.52%\)/);
  expect(cl.textContent).not.toContain("Exp.");
});

test("a symbol with no quote yet shows a dash, not a made-up price or change", () => {
  const { container } = render(<TickerTape />);
  const natgas = [...container.querySelectorAll(".tape-track > .tape-item")].find((r) => r.textContent!.includes("NATURALGAS"))!;
  expect(natgas.textContent).toContain("—");
  expect(natgas.querySelector(".up, .down")).toBeNull();
});

test("a new price updates the strip in place", () => {
  const { container } = render(<TickerTape />);
  act(() => useStore.setState((s) => ({ quotes: { ...s.quotes, "MCX:CRUDEOIL": quote("MCX:CRUDEOIL", 9300, 9311, "CRUDEOIL FUT 19 NOV 26") } })));
  expect(container.querySelector(".tape-track > .tape-item")!.textContent).toMatch(/9,300.*−11/);
});

test("clicking an item shows that symbol in the focused panel", () => {
  const first = useWorkspace.getState().widgets[0]!;
  useWorkspace.setState({ focusedId: first.id });
  const { container } = render(<TickerTape />);
  const cl = [...container.querySelectorAll(".tape-track > .tape-item")].find((r) => r.textContent!.includes("CL"))!;
  fireEvent.click(cl);
  const { widgets, groups } = useWorkspace.getState();
  const w = widgets.find((x) => x.id === first.id)!;
  expect(w.group ? groups[w.group] : w.symbol).toBe("NYMEX:CL"); // a linked panel changes its whole link group
});

test("the strip can be switched off in Settings", () => {
  useSettings.setState({ tickerTape: false });
  render(<TickerTape />);
  expect(screen.queryByLabelText("Price ticker")).toBeNull();
});

const fx = (over: Partial<FxRow> = {}): FxRow => ({ id: "USDINR", price: 94.45, change: -0.32, changePct: -0.3377, time: Date.now(), delayedBy: 0, ...over });
const fxItem = (c: HTMLElement) => c.querySelector(".tape-track > .tape-fx")!;

test("USD/INR shows its live rate, change and percent, tagged FX, in the down colour when it fell", () => {
  useStore.setState({ fx: { USDINR: fx() } });
  const { container } = render(<TickerTape />);
  const t = fxItem(container).textContent!;
  expect(t).toContain("USD/INR");
  expect(t).toContain("94.4500");
  expect(t).toMatch(/−0\.3200 \(−0\.34%\)/);
  expect(t).toContain("FX");
  expect(fxItem(container).querySelector(".down")).not.toBeNull();
  expect(fxItem(container).className).not.toContain("not-live");
});

test("USD/INR before the first reading is a dash, and a feed that stopped is dimmed, not shown as live", () => {
  useStore.setState({ fx: {} });
  const { container, rerender } = render(<TickerTape />);
  expect(fxItem(container).textContent).toContain("—");
  act(() => useStore.setState({ fx: { USDINR: fx({ time: Date.now() - 60_000 }) } }));
  rerender(<TickerTape />);
  expect(fxItem(container).className).toContain("not-live");
});

test("a delayed rate says so instead of looking live", () => {
  useStore.setState({ fx: { USDINR: fx({ delayedBy: 900 }) } });
  const { container } = render(<TickerTape />);
  expect(fxItem(container).textContent).toContain("15m delay");
});
