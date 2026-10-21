import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PaperWidget } from "./PaperPanel";
import { startPaperEngine, usePaper } from "./paperStore";
import { useStore } from "./store";
import type { Widget } from "./workspace";

const SYM = "MCX:CRUDEOIL";
const widget = { id: "pt", type: "paper", group: null, symbol: SYM, tf: "5m" } as Widget;
const WEDNESDAY_1330_IST = new Date("2026-10-21T08:00:00Z");
const SUNDAY = new Date("2026-10-25T08:00:00Z");

const quote = (price: number) => ({ symbol: SYM, price, bid: price - 1, ask: price + 1, time: Date.now(), delayedBy: 0, source: "upstox" }) as never;
const feed = (price: number) => useStore.setState({ quotes: { [SYM]: quote(price) }, seen: { [SYM]: Date.now() } });

let stop: () => void;
beforeEach(() => {
  setSystemTime(WEDNESDAY_1330_IST);
  localStorage.clear();
  usePaper.setState({ capital: 500_000, slippage: 1, positions: [], trades: [] });
  feed(9400);
  stop = startPaperEngine();
});
afterEach(() => {
  stop();
  cleanup();
  setSystemTime();
});

test("a market order fills at the ask plus slippage; a second order in the same contract is refused", () => {
  expect(usePaper.getState().place(SYM, "buy", 1, 9380)).toBeUndefined();
  const p = usePaper.getState().positions[0];
  expect(p).toMatchObject({ symbol: SYM, side: "buy", lots: 1, units: 100, entry: 9402, stop: 9380 });
  expect(usePaper.getState().place(SYM, "buy", 1)).toMatch(/Already in this contract/);
});

test("orders wait for a live market and a live price", () => {
  setSystemTime(SUNDAY);
  expect(usePaper.getState().place(SYM, "buy", 1)).toMatch(/closed or the feed is stale/);
  setSystemTime(WEDNESDAY_1330_IST);
  useStore.setState({ seen: {} });
  expect(usePaper.getState().place(SYM, "buy", 1)).toMatch(/closed or the feed is stale/);
  useStore.setState({ quotes: {} });
  expect(usePaper.getState().place(SYM, "buy", 1)).toMatch(/No live price/);
  expect(usePaper.getState().place("NYMEX:CL", "buy", 1)).toMatch(/MCX/);
});

test("the engine closes a position at the market when a live price reaches its stop", () => {
  usePaper.getState().place(SYM, "buy", 1, 9380, 9450);
  act(() => feed(9370)); // gaps through the stop
  const { positions, trades } = usePaper.getState();
  expect(positions).toHaveLength(0);
  expect(trades).toHaveLength(1);
  expect(trades[0]).toMatchObject({ reason: "stop", entry: 9402, exit: 9368 }); // sold at the bid (9369) less 1 point slippage, not at the 9380 stop
  expect(trades[0].net).toBeLessThan(trades[0].gross); // costs charged
});

test("the engine ignores a stale feed", () => {
  usePaper.getState().place(SYM, "buy", 1, 9380);
  act(() => useStore.setState({ quotes: { [SYM]: quote(9370) }, seen: { [SYM]: Date.now() - 5 * 60_000 } }));
  expect(usePaper.getState().positions).toHaveLength(1);
});

test("the panel shows the position, closes it by hand and keeps a journal note", () => {
  render(<PaperWidget widget={widget} />);
  fireEvent.click(screen.getByText(/Buy 1 lot Crude Oil at market/));
  expect(screen.getByText("Long")).toBeTruthy();
  act(() => feed(9420));
  fireEvent.click(screen.getByText("Close"));
  expect(usePaper.getState().positions).toHaveLength(0);
  expect(usePaper.getState().trades[0].reason).toBe("manual");
  const note = screen.getByLabelText(`Note for the ${SYM} trade`) as HTMLInputElement;
  fireEvent.change(note, { target: { value: "followed the plan" } });
  expect(usePaper.getState().trades[0].note).toBe("followed the plan");
});
