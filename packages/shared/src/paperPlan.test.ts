import { expect, test } from "bun:test";
import { parseOrderInput } from "./paperServer";

const order = { symbol: "MCX:NATGASMINI", side: "buy", lots: 1, stop: 288, plan: { tp1: 294, close_at: "2026-10-29T16:00:00Z" } };

test("a plan on a market order is read and checked", () => {
  const r = parseOrderInput(order);
  expect("order" in r && r.order.plan).toEqual({ tp1: 294, closeAt: Date.parse("2026-10-29T16:00:00Z") });
  expect("order" in r && "plan" in r.order).toBe(true);
  expect("order" in parseOrderInput({ ...order, plan: undefined }) && "plan" in (parseOrderInput({ ...order, plan: undefined }) as any).order).toBe(false);
  for (const plan of [{ tp1: -1, close_at: "2026-10-29T16:00:00Z" }, { tp1: "294", close_at: "2026-10-29T16:00:00Z" }, { tp1: 294, close_at: "soon" }, { tp1: 294 }]) expect("error" in parseOrderInput({ ...order, plan })).toBe(true);
  expect(parseOrderInput({ ...order, entry: 290 })).toEqual({ error: "plan is for market orders: a limit order cannot carry one" });
});

import { UPSTOX_MCX_RATES } from "./costs";
import { FakeStore } from "./paperFakes";
import type { PaperQuote } from "./paper";
import { PaperEngine } from "./paperServer";

// The engine acts on a plan by itself: at TP1 the stop goes to the entry (only tighter), and from the close time the position is closed at the market.
function setup() {
  const store = new FakeStore();
  const m: { q: PaperQuote; live: boolean } = { q: { price: 291, bid: 290.9, ask: 291.1 }, live: true };
  let t = Date.parse("2026-10-29T14:35:00Z");
  let n = 0;
  const events: any[] = [];
  const engine = new PaperEngine({ store, quote: () => m.q, live: () => m.live, rates: async () => UPSTOX_MCX_RATES, now: () => t, newId: () => `p${++n}`, publish: (e) => void events.push(e) });
  return { engine, store, m, events, at: (iso: string) => (t = Date.parse(iso)) };
}
const buy = { symbol: "MCX:NATGASMINI", side: "buy", lots: 1, stop: 288.2, plan: { tp1: 294, close_at: "2026-10-29T16:00:00Z" } };

test("at TP1 the engine moves the stop to the entry, once, and never loosens a tighter one", async () => {
  const { engine, store, m, events } = setup();
  const r = await engine.place("main", buy, "ui");
  if (!r.ok) throw new Error(r.error);
  await engine.onQuotes();
  expect((await store.positions("main"))[0].stop).toBe(288.2); // TP1 not reached
  m.q = { price: 294.2, bid: 294.1, ask: 294.3 };
  await engine.onQuotes();
  const [p] = await store.positions("main");
  expect(p.stop).toBe(p.entry);
  expect(p.plan?.tp1Done).toBe(true);
  expect(events.at(-1).text).toContain("TP1 reached");
  const n = events.length;
  await engine.onQuotes();
  expect(events).toHaveLength(n); // done once
  // a stop already above the entry stays where it is
  await store.savePosition("main", { ...p, stop: p.entry + 1, plan: { ...p.plan!, tp1Done: false } });
  (engine as any).open.set(p.id, { account: "main", position: { ...p, stop: p.entry + 1, plan: { ...p.plan!, tp1Done: false } } });
  await engine.onQuotes();
  expect((await store.positions("main"))[0].stop).toBe(p.entry + 1);
});

test("from the close time the engine closes the position at the market with reason time; a dead feed waits", async () => {
  const { engine, store, m, at, events } = setup();
  await engine.place("main", buy, "ui");
  at("2026-10-29T16:00:01Z");
  m.live = false;
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(1); // no live price: nothing is closed on a stale quote
  m.live = true;
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(0);
  const [t] = await store.trades("main", 5);
  expect(t).toMatchObject({ reason: "time", closedBy: "engine" });
  expect(events.at(-1).text).toContain("Time exit");
});

test("a position without a plan is untouched by the time and TP1 rules", async () => {
  const { engine, store, m, at } = setup();
  await engine.place("main", { ...buy, plan: undefined }, "ui");
  m.q = { price: 295, bid: 294.9, ask: 295.1 };
  at("2026-10-29T17:00:00Z");
  await engine.onQuotes();
  expect((await store.positions("main"))[0].stop).toBe(288.2);
});

// ---- USIB's trail on the server: candles from live quotes, the trail starts once TP2 is touched, moves at each candle close, never loosens
const TRAIL = { symbol: "MCX:NATGASMINI", side: "buy", lots: 1, stop: 288.2, plan: { tp1: 294, close_at: "2026-10-29T18:00:00Z", tp2: 297, trail: 2, candle_sec: 300 } };

test("the plan's trail fields are read together or refused", () => {
  const r = parseOrderInput(TRAIL);
  expect("order" in r && r.order.plan).toMatchObject({ tp2: 297, trail: 2, candleSec: 300 });
  for (const plan of [{ ...TRAIL.plan, trail: undefined }, { ...TRAIL.plan, tp2: undefined }, { ...TRAIL.plan, trail: -1 }, { ...TRAIL.plan, candle_sec: 10 }]) expect("error" in parseOrderInput({ ...TRAIL, plan })).toBe(true);
});

test("after TP2 the stop trails the best candle close by the trail, moves only at a close, and never goes back", async () => {
  const { engine, store, m, at } = setup();
  at("2026-10-29T14:35:10Z");
  m.q = { price: 291, bid: 290.9, ask: 291.1 };
  await engine.place("main", TRAIL, "ui");
  const stopOf = async () => (await store.positions("main"))[0]?.stop;
  const px = async (price: number) => {
    m.q = { price, bid: price - 0.1, ask: price + 0.1 };
    await engine.onQuotes();
  };
  await px(291.5);
  await px(297.4); // TP2 touched inside the 14:35 candle; the stop is moved to the entry by the TP1 rule only
  expect((await store.positions("main"))[0].plan?.tp2Done).toBe(true);
  expect(await stopOf()).toBe((await store.positions("main"))[0].entry);
  await px(298.4); // still the same candle: no trail move yet
  expect(await stopOf()).toBe((await store.positions("main"))[0].entry);
  at("2026-10-29T14:40:02Z"); // the 14:35 candle has closed at 298.4
  await px(298.0);
  expect(await stopOf()).toBeCloseTo(296.4, 6); // 298.4 - 2
  at("2026-10-29T14:45:02Z"); // the 14:40 candle closed at 298.0: a lower close does not loosen the stop
  await px(298.2);
  expect(await stopOf()).toBeCloseTo(296.4, 6);
  at("2026-10-29T14:50:02Z"); // the 14:45 candle closed at 298.2, still under the best close
  await px(299.5);
  expect(await stopOf()).toBeCloseTo(296.4, 6);
  at("2026-10-29T14:55:02Z"); // the 14:50 candle closed at 299.5: a new best close
  await px(299.0);
  expect(await stopOf()).toBeCloseTo(297.5, 6);
  const id = (await store.positions("main"))[0].id;
  await engine.setStopTarget("main", id, { stop: 298.5 }, "ui"); // the trader tightens it by hand, above where the trail would put it
  at("2026-10-29T15:00:02Z");
  await px(299.1);
  expect(await stopOf()).toBe(298.5); // the trail never loosens it
  expect((await store.positions("main")).length).toBe(1); // TP2 does not close the trade
});

test("the trail does not start before TP2 and a short trails over the best (lowest) close", async () => {
  const { engine, store, m, at } = setup();
  at("2026-10-29T14:35:10Z");
  await engine.place("main", TRAIL, "ui");
  at("2026-10-29T14:40:02Z");
  m.q = { price: 292, bid: 291.9, ask: 292.1 };
  await engine.onQuotes();
  at("2026-10-29T14:45:02Z");
  await engine.onQuotes();
  expect((await store.positions("main"))[0].stop).toBe(288.2); // TP2 never touched: nothing trails
  const s = setup();
  s.at("2026-10-29T14:35:10Z");
  s.m.q = { price: 291, bid: 290.9, ask: 291.1 };
  await s.engine.place("main", { symbol: "MCX:NATGASMINI", side: "sell", lots: 1, stop: 293.8, plan: { tp1: 288, close_at: "2026-10-29T18:00:00Z", tp2: 285, trail: 2 } }, "ui");
  s.m.q = { price: 284.6, bid: 284.5, ask: 284.7 };
  await s.engine.onQuotes();
  s.at("2026-10-29T14:40:02Z");
  s.m.q = { price: 284.0, bid: 283.9, ask: 284.1 };
  await s.engine.onQuotes();
  expect((await s.store.positions("main"))[0].stop).toBeCloseTo(286.6, 6); // the 14:35 candle closed at 284.6; + 2 (under the entry the TP1 stop moved first)
});
