import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SourceBadge } from "./widgets";
import { useStore } from "./store";

const SYM = "MCX:CRUDEOIL";
const quote = (extra: object = {}) => ({ symbol: SYM, price: 9483, time: Date.now() - 2000, delayedBy: 0, source: "upstox", ...extra }) as never;

beforeEach(() => {
  setSystemTime(new Date("2026-10-21T08:00:00Z")); // Wednesday 13:30 IST: MCX open
  useStore.setState({ seen: { [SYM]: Date.now() } });
});
afterEach(() => {
  cleanup();
  setSystemTime();
});

test("the source badge carries the provenance in plain words", () => {
  useStore.setState({ quotes: { [SYM]: quote() } });
  render(<SourceBadge symbol={SYM} />);
  expect(screen.getByText("UPSTOX").getAttribute("title")).toBe("upstox, live, as of 2s ago");
  expect(screen.queryByText("FEEDS DIFFER")).toBeNull();
});

test("a quote the stream marked as disputed shows FEEDS DIFFER with who disagrees and by how much", () => {
  useStore.setState({ quotes: { [SYM]: quote({ drift: { between: ["tradingview", "upstox"], pct: 0.31, ticks: 29 } }) } });
  render(<SourceBadge symbol={SYM} />);
  const badge = screen.getByText("FEEDS DIFFER");
  expect(badge.getAttribute("title")).toContain("tradingview and upstox differ by 0.31% (29 ticks)");
  expect(screen.getByText("UPSTOX").getAttribute("title")).toContain("differ by 0.31%");
});

test("a closed market says closed in the provenance", () => {
  setSystemTime(new Date("2026-10-25T08:00:00Z")); // Sunday
  useStore.setState({ quotes: { [SYM]: quote({ time: Date.now() - 3600_000 }) }, seen: {} });
  render(<SourceBadge symbol={SYM} />);
  expect(screen.getByText("UPSTOX").getAttribute("title")).toBe("upstox, closed, as of 60m ago");
});
