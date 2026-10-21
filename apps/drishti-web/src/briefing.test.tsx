import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BriefingWidget, gatherContext, useJournal } from "./BriefingPanel";
import { useStore } from "./store";
import type { Widget } from "./workspace";

const widget = { id: "br", type: "briefing", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
const T0 = 1_760_000_000;
const bars = Array.from({ length: 60 }, (_, i) => ({ time: T0 + i * 300, open: 9000 + i, high: 9005 + i, low: 8995 + i, close: 9002 + i, volume: 10 }));
const result = {
  bias: "bullish",
  confidence: "medium",
  summary: "Crude is firm.",
  bull: [{ point: "Momentum is up", evidence: "rsi14 71" }],
  bear: [{ point: "Stretched", evidence: "bollingerPos 0.95" }],
  watch: ["EIA at 20:00 IST"],
  data_gaps: ["No inventory forecast"],
};
let posted: unknown;

beforeEach(() => {
  posted = undefined;
  useJournal.setState({ entries: [] });
  useStore.setState({
    quotes: { "MCX:CRUDEOIL": { symbol: "MCX:CRUDEOIL", price: 9100, prevClose: 9000, time: Date.now(), delayedBy: 0, source: "upstox" } as never },
    news: [{ id: "n1", title: "Brent climbs", url: "u", source: "Reuters", publishedAt: Date.now() - 60_000, tags: ["crude"] }],
  });
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/briefing")) {
      posted = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ result, model: "claude-opus-5-5", asOf: "x", generatedAt: Date.now(), usage: { input: 1, output: 1 }, cached: false }) };
    }
    if (String(url).includes("/bars")) return { ok: true, status: 200, json: async () => bars };
    return { ok: false, status: 404, json: async () => ({}) }; // calendar / options unavailable: briefing still works
  }) as never;
});
afterEach(cleanup);

test("gatherContext needs a live price, then packs indicators and headlines", async () => {
  useStore.setState({ quotes: {} });
  await expect(gatherContext("MCX:CRUDEOIL", "5m")).rejects.toThrow(/No live price/);
  useStore.setState({ quotes: { "MCX:CRUDEOIL": { symbol: "MCX:CRUDEOIL", price: 9100, time: 1, delayedBy: 0, source: "upstox" } as never } });
  const c = await gatherContext("MCX:CRUDEOIL", "5m");
  expect(c.technicals.rsi14).toBeDefined();
  expect(c.technicals.timeframe).toBe("5m");
});

test("generating a briefing posts the context, shows both cases and journals it", async () => {
  render(<BriefingWidget widget={widget} />);
  fireEvent.click(screen.getByText(/Brief me on CRUDEOIL/));
  expect(await screen.findByText("Crude is firm.")).toBeTruthy();
  expect(screen.getByText("Momentum is up")).toBeTruthy();
  expect(screen.getByText("Stretched")).toBeTruthy();
  expect((posted as { context: { symbol: string; news: { title: string }[] } }).context.news[0].title).toBe("Brent climbs");
  expect(useJournal.getState().entries).toHaveLength(1);
  expect(document.body.textContent).toContain("too early to grade");
});

test("a server error (no API key) is shown instead of a briefing", async () => {
  globalThis.fetch = mock(async (url: string) =>
    String(url).includes("/briefing")
      ? { ok: false, status: 503, json: async () => ({ message: "Set ANTHROPIC_API_KEY in .env to enable AI briefings" }) }
      : { ok: true, status: 200, json: async () => bars },
  ) as never;
  render(<BriefingWidget widget={widget} />);
  fireEvent.click(screen.getByText(/Brief me on/));
  expect(await screen.findByText(/ANTHROPIC_API_KEY/)).toBeTruthy();
  expect(useJournal.getState().entries).toHaveLength(0);
});
