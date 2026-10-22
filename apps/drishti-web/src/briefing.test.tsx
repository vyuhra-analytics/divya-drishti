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

test("the bar still forming is left out of the facts", async () => {
  const open5 = Math.floor(Date.now() / 1000 / 300) * 300; // the current 5m bar opened this second-ish ago and has not closed
  const forming = { time: open5, open: 5000, high: 5001, low: 4999, close: 5000, volume: 1 };
  globalThis.fetch = mock(async (url: string) => (String(url).includes("/bars") ? { ok: true, status: 200, json: async () => [...bars, forming] } : { ok: false, status: 404, json: async () => ({}) })) as never;
  const c = await gatherContext("MCX:CRUDEOIL", "5m");
  // the 5000 print of the forming bar would drag the 20-bar change far negative; the last completed close is 9061
  expect(c.technicals.changeOverBars!.pct).toBeGreaterThan(0);
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

test("the position is shared only when opted in, and a failed read is 'unavailable', not 'flat'", async () => {
  const held = [{ symbol: "MCX:CRUDEOIL", contract: "CRUDEOIL 19 NOV 26 FUT", kind: "future", netQty: 100, avgPrice: 9300, lastPrice: 9384, pnl: 8400 }];
  const base = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<unknown>;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) =>
    String(url).includes("/positions") ? { ok: true, status: 200, json: async () => ({ positions: held }) } : base(url, init),
  ) as never;
  expect((await gatherContext("MCX:CRUDEOIL", "5m")).position).toBeUndefined(); // not opted in: nothing sent
  expect((await gatherContext("MCX:CRUDEOIL", "5m", true)).position).toMatchObject({ status: "open", side: "long", netQty: 100 });
  globalThis.fetch = mock(async (url: string, init?: RequestInit) =>
    String(url).includes("/positions") ? { ok: false, status: 403, json: async () => ({ message: "no" }) } : base(url, init),
  ) as never;
  expect((await gatherContext("MCX:CRUDEOIL", "5m", true)).position).toEqual({ status: "unavailable" });
});

test("the facts carry provenance: feed, live or closed, a feed conflict, and when the indicators are as of", async () => {
  useStore.setState({ quotes: { "MCX:CRUDEOIL": { symbol: "MCX:CRUDEOIL", price: 9100, time: Date.now() - 5000, delayedBy: 0, source: "upstox", drift: { between: ["tradingview", "upstox"], pct: 0.3, ticks: 27 } } as never }, seen: {} });
  const c = await gatherContext("MCX:CRUDEOIL", "5m");
  expect(c.provenance.price).toMatchObject({ source: "upstox", conflict: { between: ["tradingview", "upstox"], pct: 0.3, ticks: 27 } });
  expect(["stale", "closed"]).toContain(c.provenance.price.quality); // no heartbeat: never described as live
  expect(c.provenance.technicals).toEqual({ source: "computed", quality: "computed", asOf: (bars[bars.length - 1].time + 300) * 1000 });
  expect(c.provenance.news).toMatchObject({ source: "rss", quality: "published" });
});

const grounded = {
  ...result,
  bull: [
    { point: "Momentum is up", evidence: "rsi14 71", cites: [{ field: "technicals.rsi14", value: "71" }] },
    { point: "Breaking out", evidence: "price 9300", cites: [{ field: "price", value: "9300" }] },
  ],
  bear: [{ point: "Sentiment is poor", evidence: "mood" }],
};
const report = {
  total: 3,
  verified: 1,
  wrong: 1,
  other: [{ kind: "loose", text: "9500 is not in the data." }],
  points: [
    { section: "bull", index: 0, verdict: "verified", issues: [] },
    { section: "bull", index: 1, verdict: "wrong", issues: [{ kind: "wrong", text: "price is 9100, not 9300." }] },
    { section: "bear", index: 0, verdict: "unverified", issues: [{ kind: "loose", text: "No data cited for this point." }] },
  ],
};

test("each point shows whether code could check it against the data, and what the data really says when it does not match", async () => {
  globalThis.fetch = mock(async (url: string) =>
    String(url).includes("/briefing")
      ? { ok: true, status: 200, json: async () => ({ result: grounded, model: "m", asOf: "x", generatedAt: Date.now(), usage: { input: 1, output: 1 }, grounding: report, attempts: 2, cached: false }) }
      : { ok: true, status: 200, json: async () => bars },
  ) as never;
  render(<BriefingWidget widget={widget} />);
  fireEvent.click(screen.getByText(/Brief me on/));
  await screen.findByText("Crude is firm.");
  expect(screen.getByText(/1 of 3 points checked against the data/)).toBeTruthy();
  expect(screen.getByText(/1 contradicts it/)).toBeTruthy();
  expect(screen.getByText(/corrected once after a mismatch/)).toBeTruthy();
  expect(screen.getByLabelText("Checked against the data")).toBeTruthy();
  expect(screen.getByLabelText("Contradicts the data")).toBeTruthy();
  expect(screen.getByLabelText("Could not be fully checked")).toBeTruthy();
  expect(screen.getByText(/Data says: price is 9100, not 9300\./)).toBeTruthy();
  expect(screen.getByText(/Summary: 9500 is not in the data\./)).toBeTruthy();
  expect(useJournal.getState().entries[0]!.grounding?.wrong).toBe(1); // kept with the entry
});

test("a briefing saved before checking existed says so instead of looking verified", async () => {
  render(<BriefingWidget widget={widget} />);
  fireEvent.click(screen.getByText(/Brief me on/)); // the default mock response carries no grounding
  await screen.findByText("Crude is firm.");
  expect(screen.getByText(/Not checked against the data/)).toBeTruthy();
  expect(screen.queryByLabelText("Checked against the data")).toBeNull();
});

test("a briefing Claude submitted over MCP appears in the journal and the panel, with its checked verdicts, and is not added twice", async () => {
  const row = {
    id: "bm-9",
    symbol: "MCX:CRUDEOIL",
    at: Date.now() - 60_000,
    priceThen: 9100,
    result: { ...grounded, summary: "Written over MCP." },
    grounding: { total: 1, verified: 1, wrong: 0, other: [], points: [{ section: "bull", index: 0, verdict: "verified", issues: [] }] },
  };
  globalThis.fetch = mock(async (url: string) => (String(url).includes("/briefing/submitted") ? { ok: true, status: 200, json: async () => [row] } : { ok: false, status: 404, json: async () => ({}) })) as never;
  render(<BriefingWidget widget={widget} />);
  expect(await screen.findByText("Written over MCP.")).toBeTruthy();
  expect(screen.getByText(/Written by Claude over MCP and submitted to the app/)).toBeTruthy();
  expect(screen.getByText(/1 of 1 points checked against the data/)).toBeTruthy();
  expect(useJournal.getState().entries.filter((e) => e.id === "bm-9")).toHaveLength(1);
  useStore.setState((s) => ({ briefingRev: s.briefingRev + 1 })); // the stream announces it again: no duplicate
  await new Promise((r) => setTimeout(r, 30));
  expect(useJournal.getState().entries.filter((e) => e.id === "bm-9")).toHaveLength(1);
});
