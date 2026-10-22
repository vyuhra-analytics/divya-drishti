import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { useStore } from "./store";

// The exchange's own status (from the heartbeat) corrects the session rules in the status bar: pinned to a Wednesday 20:00 IST,
// when the rules say MCX is open.
const NOW = Date.parse("2026-10-21T20:00:00+05:30");
beforeEach(() => {
  setSystemTime(new Date(NOW));
  globalThis.fetch = mock(async () => ({ ok: true, status: 200, json: async () => ({ active: {}, providers: {} }) })) as never;
});
afterEach(() => {
  cleanup();
  setSystemTime();
  useStore.setState({ mcxStatus: undefined });
});

test("with no status the rules decide: MCX shows open on a Wednesday evening", () => {
  render(<StatusBar />);
  expect(screen.getByText("MCX", { exact: false }).textContent).toMatch(/Open/);
});

test("a fresh NORMAL_CLOSE from Upstox shows MCX closed even though the rules say open, and says where it comes from", () => {
  useStore.setState({ mcxStatus: { state: "NORMAL_CLOSE", at: NOW - 5_000 } });
  render(<StatusBar />);
  const item = screen.getByText("MCX", { exact: false }).closest(".sb-item")!;
  expect(item.textContent).toMatch(/Closed/);
  expect(item.getAttribute("title")).toMatch(/Exchange status from Upstox: NORMAL_CLOSE/);
});

test("a status older than two minutes is ignored, and an unknown value is never read as closed", () => {
  useStore.setState({ mcxStatus: { state: "NORMAL_CLOSE", at: NOW - 5 * 60_000 } });
  render(<StatusBar />);
  expect(screen.getByText("MCX", { exact: false }).textContent).toMatch(/Open/);
  cleanup();
  useStore.setState({ mcxStatus: { state: "SOMETHING_NEW", at: NOW } });
  render(<StatusBar />);
  expect(screen.getByText("MCX", { exact: false }).textContent).toMatch(/Open/);
});
