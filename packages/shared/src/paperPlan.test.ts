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
