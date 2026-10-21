import { expect, test } from "bun:test";
import { briefingPrompt, buildContext, scoreBriefing, type ContextInput } from "./briefing";
import type { Bar, Quote } from "./index";

const T0 = 1_760_000_000;
const bars: Bar[] = Array.from({ length: 80 }, (_, i) => {
  const close = 9000 + i * 2; // steady climb
  return { time: T0 + i * 300, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 };
});
const quote: Quote = { symbol: "MCX:CRUDEOIL", price: 9158, time: T0 * 1000, prevClose: 9000, open: 9010, high: 9170, low: 8990, oi: 14600, atp: 9100.456, totalBuyQty: 300, totalSellQty: 100, source: "upstox", delayedBy: 0 };
const now = T0 * 1000;
const input = (over: Partial<ContextInput> = {}): ContextInput => ({
  symbol: "MCX:CRUDEOIL",
  quote,
  bars,
  timeframe: "5m",
  news: [{ id: "a", title: "Brent climbs", url: "u", source: "Reuters", publishedAt: now - 10 * 60_000, tags: ["crude"] }],
  events: [],
  now,
  ...over,
});

test("buildContext computes the numbers the model will quote", () => {
  const c = buildContext(input());
  expect(c.price).toBe(9158);
  expect(c.changePct).toBe(1.76); // (9158-9000)/9000
  expect(c.book).toMatchObject({ oi: 14600, atp: 9100.46, buyPressurePct: 75 });
  expect(c.technicals.timeframe).toBe("5m");
  expect(c.technicals.rsi14).toBe(100); // only gains
  expect(c.technicals.ema20!).toBeLessThan(9158);
  expect(c.technicals.ema20!).toBeGreaterThan(c.technicals.ema50!);
  expect(c.technicals.changeOverBars).toEqual({ bars: 20, pct: 0.44 });
  expect(c.news[0]).toEqual({ n: 1, title: "Brent climbs", source: "Reuters", ageMin: 10, tags: ["crude"] });
});

test("buildContext keeps upcoming and just-released events, drops holidays and far-off ones", () => {
  const ev = (title: string, minFromNow: number, kind: "energy" | "holiday" = "energy") => ({ id: title, title, at: now + minFromNow * 60_000, kind, impact: "high" as const });
  const c = buildContext(input({ events: [ev("EIA soon", 90), ev("Released", -60), ev("Too far", 60 * 72), ev("MCX closed", 30, "holiday"), ev("Long ago", -60 * 12)] }));
  expect(c.events.map((e) => [e.title, e.inMin])).toEqual([["EIA soon", 90], ["Released", -60]]);
});

test("buildContext survives a short history", () => {
  const c = buildContext(input({ bars: bars.slice(0, 3), news: [] }));
  expect(c.technicals.rsi14).toBeUndefined();
  expect(c.technicals.changeOverBars?.bars).toBe(2);
});

test("the prompt carries the whole context as JSON", () => {
  const p = briefingPrompt(buildContext(input()));
  expect(p).toContain('"symbol":"MCX:CRUDEOIL"');
  expect(JSON.parse(p.slice(p.indexOf("\n") + 1)).price).toBe(9158);
});

test("scoreBriefing grades direction, with a band for neutral", () => {
  expect(scoreBriefing("bullish", 100, 101)).toMatchObject({ hit: true });
  expect(scoreBriefing("bullish", 100, 99).hit).toBe(false);
  expect(scoreBriefing("bearish", 100, 99).hit).toBe(true);
  expect(scoreBriefing("neutral", 100, 100.2).hit).toBe(true);
  expect(scoreBriefing("neutral", 100, 101).hit).toBe(false);
  expect(scoreBriefing("bullish", 200, 210).movePct).toBe(5);
});
