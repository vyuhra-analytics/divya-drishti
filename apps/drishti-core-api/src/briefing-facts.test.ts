import { expect, test } from "bun:test";
import { BadRequestException, GoneException, ServiceUnavailableException } from "@nestjs/common";
import type { Bar, Quote } from "@drishti/shared";
import { gatherServerContext, marketStatus, recap, technicals, type Sources } from "./briefing-facts";
import { BriefingFactsController } from "./briefing-facts.controller";

// A Wednesday 15:00 UTC: MCX (20:30 IST), NYMEX and FX are all open.
const NOW = Date.parse("2026-10-21T15:00:00Z");
const bars: Bar[] = Array.from({ length: 80 }, (_, i) => ({ time: NOW / 1000 - (80 - i) * 300, open: 9000 + i, high: 9005 + i, low: 8995 + i, close: 9002 + i, volume: 10 }));
const quote = (symbol: string): Quote => ({ symbol, price: 9100, prevClose: 9000, time: NOW, source: "upstox", delayedBy: 0 });

function sources(over: { quote?: Quote | undefined; heardAgoMs?: number; paths?: string[]; now?: number } = {}): Sources {
  return {
    now: () => over.now ?? NOW,
    async api(path: string) {
      over.paths?.push(path);
      if (path.startsWith("/quotes/")) return ("quote" in over ? over.quote : quote(decodeURIComponent(path.slice(8)))) as never;
      if (path.startsWith("/bars")) return [...bars, { time: Math.floor(NOW / 1000 / 300) * 300, open: 1, high: 1, low: 1, close: 1, volume: 1 }] as never; // plus a bar still forming
      if (path.startsWith("/news")) return [{ id: "n", title: "Brent climbs", url: "u", source: "Reuters", publishedAt: NOW - 60_000, tags: ["crude"] }] as never;
      return undefined;
    },
    async health() {
      return {
        active: { "MCX:CRUDEOIL": "upstox", "FX:USDINR": "tradingview" },
        prices: { "MCX:CRUDEOIL": { upstox: { price: 9100, at: NOW - (over.heardAgoMs ?? 1000) }, tradingview: { price: 9101, at: NOW - 2000 } }, "FX:USDINR": { tradingview: { price: 94.45, at: NOW - 1000 } } },
        providers: { upstox: { ok: 10, failed: 0, lastError: null, lastOkAt: NOW - 1000, latencyMs: 5 } },
        rejected: { count: 2 },
      };
    },
  };
}

test("the server-side context has the same facts the panel gathers: price, indicators from completed bars, headlines, provenance", async () => {
  const c = await gatherServerContext("MCX:CRUDEOIL", "5m", sources());
  expect(c.price).toBe(9100);
  expect(c.changePct).toBe(1.11);
  expect(c.technicals.rsi14).toBeDefined();
  expect(c.technicals.changeOverBars!.pct).toBeGreaterThan(0); // the forming bar (close 1) is left out
  expect(c.news[0]).toMatchObject({ title: "Brent climbs", source: "Reuters" });
  expect(c.provenance.price).toMatchObject({ source: "upstox", quality: "live" });
  expect(c.position).toBeUndefined(); // the trader's own position never goes into an agent's context
});

test("a feed not heard from for over a minute is stale, and a closed market is closed", async () => {
  expect((await gatherServerContext("MCX:CRUDEOIL", "5m", sources({ heardAgoMs: 120_000 }))).provenance.price.quality).toBe("stale");
  const saturday = Date.parse("2026-10-24T15:00:00Z");
  expect((await gatherServerContext("MCX:CRUDEOIL", "5m", sources({ now: saturday }))).provenance.price.quality).toBe("closed");
});

test("headlines are asked for by the instrument's topic; a currency has none, so it gets all", async () => {
  const crude: string[] = [];
  await gatherServerContext("MCX:CRUDEOIL", "5m", sources({ paths: crude }));
  expect(crude.find((p) => p.startsWith("/news"))).toBe("/news?limit=15&tags=crude,oil");
  const fx: string[] = [];
  await gatherServerContext("FX:USDINR", "5m", sources({ paths: fx }));
  expect(fx.find((p) => p.startsWith("/news"))).toBe("/news?limit=15");
  expect(fx.some((p) => p.startsWith("/options"))).toBe(false); // options are for MCX underlyings only
});

test("no live price is an error, not a briefing from nothing", async () => {
  await expect(gatherServerContext("MCX:CRUDEOIL", "5m", sources({ quote: undefined }))).rejects.toThrow(/no live price/);
});

// ---- the controller, with a fake database and fake facts
function controller() {
  const inserts: unknown[][] = [];
  const announced: unknown[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("INSERT INTO briefings")) inserts.push(values);
    return Promise.resolve(text.includes("FROM briefings") ? [{ id: "bm-1", symbol: "MCX:CRUDEOIL", at: 1_760_000_000_000, source: "claude-mcp", price_then: 9100, result: { bias: "bullish" }, grounding: { verified: 1 } }] : []);
  };
  const c = new BriefingFactsController({ sql } as never);
  c.sources = sources();
  c.announce = async (a) => void announced.push(a);
  return { c, inserts, announced };
}
const submission = (context_id: string, over: Record<string, unknown> = {}) => ({
  symbol: "MCX:CRUDEOIL",
  context_id,
  bias: "bullish",
  confidence: "medium",
  summary: "Crude is firm.",
  bull: [{ point: "Price is 9100", evidence: "price 9100", cites: [{ field: "price", value: "9100" }] }],
  bear: [{ point: "Day change", evidence: "changePct 1.11", cites: [{ field: "changePct", value: "1.11" }] }],
  watch: [],
  data_gaps: [],
  ...over,
});

test("the context endpoint rejects an unknown symbol or timeframe and a missing price, and hands out the citable fields under an id", async () => {
  const { c } = controller();
  await expect(c.context("MCX:GOLD")).rejects.toBeInstanceOf(BadRequestException);
  await expect(c.context("MCX:CRUDEOIL", "2h")).rejects.toBeInstanceOf(BadRequestException);
  c.sources = sources({ quote: undefined });
  await expect(c.context("MCX:CRUDEOIL")).rejects.toBeInstanceOf(ServiceUnavailableException);
  c.sources = sources();
  const r = await c.context("MCX:CRUDEOIL");
  expect(r.context_id).toStartWith("ctx-");
  expect(r.citable.price).toBe(9100);
  expect(r.instructions).toContain("submit_briefing");
  expect(r.context.symbol).toBe("MCX:CRUDEOIL");
});

test("a briefing whose cites match the context is stored, announced, and reported as checked", async () => {
  const { c, inserts, announced } = controller();
  const { context_id } = await c.context("MCX:CRUDEOIL");
  const r = await c.submit(submission(context_id));
  expect(r).toMatchObject({ stored: true, verified: 2, total: 2, wrong: 0, points: [] });
  expect(inserts).toHaveLength(1);
  expect(inserts[0]).toContain("claude-mcp");
  expect(announced).toEqual([{ id: r.id, symbol: "MCX:CRUDEOIL", bias: "bullish", verified: 2, total: 2, wrong: 0 }]);
});

test("a contradicted cite is still stored, and the reply says exactly which point and what the data holds so the agent can correct it", async () => {
  const { c, inserts } = controller();
  const { context_id } = await c.context("MCX:CRUDEOIL");
  const r = await c.submit(submission(context_id, { bull: [{ point: "Price is 9500", evidence: "price 9500", cites: [{ field: "price", value: "9500" }] }] }));
  expect(r.wrong).toBe(1);
  expect(r.points[0]).toMatchObject({ section: "bull", point: 1, verdict: "wrong" });
  expect(r.points[0]!.issues[0]).toContain("price is 9100, not 9500");
  expect(r.next).toContain("submit again");
  expect(inserts).toHaveLength(1);
});

test("an unknown or expired context, a context for another symbol and a malformed body are refused, and nothing is stored", async () => {
  const { c, inserts } = controller();
  await expect(c.submit(submission("ctx-nope"))).rejects.toBeInstanceOf(GoneException);
  const { context_id } = await c.context("MCX:CRUDEOIL");
  await expect(c.submit(submission(context_id, { symbol: "NYMEX:CL" }))).rejects.toThrow(/is for MCX:CRUDEOIL/);
  await expect(c.submit({ bias: "bullish" })).rejects.toBeInstanceOf(BadRequestException);
  await expect(c.submit(submission(context_id, { symbol: "MCX:GOLD" }))).rejects.toBeInstanceOf(BadRequestException);
  expect(inserts).toHaveLength(0);
});

test("submitted briefings come back newest first with their grounding", async () => {
  const { c } = controller();
  const rows = await c.submitted("5");
  expect(rows[0]).toMatchObject({ id: "bm-1", symbol: "MCX:CRUDEOIL", source: "claude-mcp", priceThen: 9100, at: 1_760_000_000_000 });
});

test("technicals are the computed numbers only, with where the price comes from", async () => {
  const t = await technicals("MCX:CRUDEOIL", "5m", sources());
  expect(t).toMatchObject({ symbol: "MCX:CRUDEOIL", price: 9100 });
  expect(t.technicals.rsi14).toBeDefined();
  expect(t.stats.atr14).toBeDefined();
  expect(t.provenance.price.quality).toBe("live");
  expect("news" in t).toBe(false); // headlines are a different tool
});

test("the recap is the no-AI summary, refused for a currency", async () => {
  const r = await recap("MCX:CRUDEOIL", sources());
  expect(r.headline).toContain("Crude Oil is at 9100");
  expect(Array.isArray(r.lines)).toBe(true);
  await expect(recap("FX:USDINR", sources())).rejects.toThrow(/covers the energy futures/);
});

test("market status says per instrument: session, serving feed, live or stale, whether the feeds agree; and per provider how it is doing", async () => {
  const m = await marketStatus(sources());
  const crude = m.instruments.find((i) => i.symbol === "MCX:CRUDEOIL")!;
  expect(crude).toMatchObject({ session: "open", quality: "live", feed: "upstox", agreement: "agree", heardSecondsAgo: 1 });
  expect(m.instruments.find((i) => i.symbol === "FX:USDINR")!.agreement).toBe("one feed only (no comparison)"); // not a pass
  expect(m.sessions.MCX.open).toBe(true);
  expect(m.feeds.upstox).toMatchObject({ ok: 10, failed: 0 });
  expect(m.rejectedQuotes).toBe(2);
  const stale = await marketStatus(sources({ heardAgoMs: 120_000 }));
  expect(stale.instruments.find((i) => i.symbol === "MCX:CRUDEOIL")!.quality).toBe("stale");
});

test("with the stream down the status says feed state is unknown instead of looking healthy", async () => {
  const s = sources();
  s.health = async () => undefined;
  const m = await marketStatus(s);
  expect(m.warning).toContain("not reachable");
  expect(m.instruments.every((i) => i.quality !== "live")).toBe(true);
});
