import { expect, test } from "bun:test";
import { UPSTOX_MCX_RATES } from "./costs";
import { FakeStore } from "./paperFakes";
import type { OptionRef, PaperQuote } from "./paper";
import { hasEntry, PaperEngine, parseOptionOrder, parseOrderInput, PENDING_TTL_MS } from "./paperServer";

// Limit orders: an order that names an entry price waits for the market to reach it (a buy when the ask is at or under it, a sell when the bid is at or over
// it), fills at that price or better with no slippage, and is cancelled after 24 hours. Over a fake store and fake feeds.
const KEY = "MCX_FO|583810";
const info: OptionRef & { lot: number; expiresAt: number } = { key: KEY, label: "CRUDEOIL 9600 PE 17 NOV 26", underlying: "CRUDEOIL", type: "PE", strike: 9600, expiry: "2026-11-17", tick: 0.1, lot: 100, expiresAt: Date.parse("2026-11-17T18:00:00Z") };

function setup() {
  const store = new FakeStore();
  const fut: { q: PaperQuote | undefined; live: boolean } = { q: { price: 9400, bid: 9399, ask: 9401 }, live: true };
  const opt: { q: PaperQuote | undefined; live: boolean } = { q: { price: 500, bid: 499, ask: 501 }, live: true };
  let n = 0;
  let t = Date.parse("2026-10-28T10:00:00Z");
  const events: any[] = [];
  const engine = new PaperEngine({
    store,
    quote: (s) => (s === "MCX:CRUDEOIL" ? fut.q : undefined),
    live: () => fut.live,
    option: { info: async (k) => (k === KEY ? info : undefined), quote: () => opt.q, live: () => opt.live },
    rates: async () => UPSTOX_MCX_RATES,
    now: () => t,
    newId: () => `x${++n}`,
    publish: (e) => void events.push(e),
  });
  return { engine, store, fut, opt, events, tick: (ms: number) => (t += ms) };
}
const buy = (over: object = {}) => ({ symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, entry: 9380, ...over });
const sell = (over: object = {}) => ({ symbol: "MCX:CRUDEOIL", side: "sell", lots: 1, entry: 9420, ...over });
const optBuy = (over: object = {}) => ({ option: { key: KEY }, side: "buy", lots: 1, entry: 480, ...over });
const ok = <T>(r: { ok: boolean } & T) => {
  if (!r.ok) throw new Error((r as { error?: string }).error);
  return r;
};

test("the entry price is read strictly, and an order with one is told apart", () => {
  expect(hasEntry(buy())).toBe(true);
  expect(hasEntry({ symbol: "MCX:CRUDEOIL", side: "buy", lots: 1 })).toBe(false);
  expect(hasEntry({ symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, entry: "" })).toBe(false); // an empty box is the market
  expect(parseOrderInput(buy({ entry: "9380.5" }))).toMatchObject({ order: { entry: 9380.5 } });
  for (const bad of [0, -5, "abc", true]) expect("error" in parseOrderInput(buy({ entry: bad }))).toBe(true);
  expect(parseOptionOrder(optBuy())).toMatchObject({ order: { key: KEY, entry: 480 } });
  expect("error" in parseOptionOrder(optBuy({ entry: -1 }))).toBe(true);
});

test("a buy limit under the ask waits; when a live ask reaches it the order fills at that ask with no slippage and the position records the limit", async () => {
  const { engine, store, fut, events, tick } = setup();
  const r = ok(await engine.placeLimit("main", buy(), "ui"));
  expect(r.pending).toMatchObject({ symbol: "MCX:CRUDEOIL", side: "buy", entry: 9380, units: 100 });
  expect(r.pending!.expiresAt).toBe(r.pending!.createdAt + PENDING_TTL_MS);
  expect(await store.positions("main")).toHaveLength(0);
  expect((await store.pendingOrders("main"))[0].id).toBe(r.pending!.id);
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(0); // the ask is still 9401
  fut.q = { price: 9379, bid: 9378, ask: 9379.5 };
  tick(1000);
  await engine.onQuotes();
  const [p] = await store.positions("main");
  expect(p).toMatchObject({ symbol: "MCX:CRUDEOIL", side: "buy", entry: 9379.5, lots: 1, actor: "ui" });
  expect(p.fill).toMatchObject({ limit: 9380, slippageTicks: 0, price: 9379.5 });
  expect(await store.pendingOrders("main")).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ event: "opened", actor: "engine" });
  expect(events.at(-1).text).toContain("Limit filled");
});

test("a limit the market is already at fills at once at the market price (the limit or better)", async () => {
  const { engine, store } = setup();
  const r = ok(await engine.placeLimit("main", buy({ entry: 9450 }), "ui")); // a buy limit above the ask of 9401
  expect(r.position).toMatchObject({ entry: 9401, side: "buy" });
  expect(r.pending).toBeUndefined();
  expect(await store.pendingOrders("main")).toHaveLength(0);
  expect((await store.positions("main"))[0].fill).toMatchObject({ limit: 9450, slippageTicks: 0 });
});

test("a sell limit waits for the bid to reach it", async () => {
  const { engine, store, fut } = setup();
  ok(await engine.placeLimit("main", sell(), "ui")); // bid is 9399, limit 9420
  fut.q = { price: 9420, bid: 9421, ask: 9422 };
  await engine.onQuotes();
  expect((await store.positions("main"))[0]).toMatchObject({ side: "sell", entry: 9421 });
});

test("nothing fills on a quote that is not live, and it fills once the market is live again", async () => {
  const { engine, store, fut } = setup();
  ok(await engine.placeLimit("main", buy(), "ui"));
  fut.q = { price: 9370, bid: 9369, ask: 9371 };
  fut.live = false;
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(0);
  fut.live = true;
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(1);
});

test("a stop and a target are checked against the ENTRY price, with the engine's words", async () => {
  const { engine } = setup();
  const bad = await engine.placeLimit("main", buy({ stop: 9390 }), "ui"); // above a buy at 9380
  expect(bad).toMatchObject({ ok: false, status: 400 });
  expect(bad.ok === false && bad.error).toContain("entry price (9380)");
  expect(await engine.placeLimit("main", buy({ target: 9370 }), "ui")).toMatchObject({ ok: false, status: 400 });
  expect((await engine.placeLimit("main", buy({ stop: 9350, target: 9450 }), "ui")).ok).toBe(true);
});

test("a stop on a limit-filled position then fires like any other", async () => {
  const { engine, store, fut } = setup();
  ok(await engine.placeLimit("main", buy({ stop: 9350 }), "ui"));
  fut.q = { price: 9379, bid: 9378, ask: 9379 };
  await engine.onQuotes();
  fut.q = { price: 9340, bid: 9339, ask: 9341 };
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(0);
  expect((await store.trades("main", 1))[0]).toMatchObject({ reason: "stop", closedBy: "engine" });
});

test("a waiting order can be cancelled, once", async () => {
  const { engine, store } = setup();
  const r = ok(await engine.placeLimit("main", buy(), "ui"));
  expect(ok(await engine.cancelOrder("main", r.pending!.id, "ui")).order.id).toBe(r.pending!.id);
  expect(await store.pendingOrders("main")).toHaveLength(0);
  expect(await engine.cancelOrder("main", r.pending!.id, "ui")).toMatchObject({ ok: false, status: 404 });
});

test("an order not filled in 24 hours is cancelled with the reason", async () => {
  const { engine, store, tick, events } = setup();
  ok(await engine.placeLimit("main", buy(), "ui"));
  tick(PENDING_TTL_MS + 1000);
  await engine.onQuotes();
  expect(await store.pendingOrders("main")).toHaveLength(0);
  expect(await store.positions("main")).toHaveLength(0);
  expect(events.at(-1).text).toContain("not filled in 24 hours");
  expect(store.log.at(-1)).toMatchObject({ action: "cancel_order", actor: "engine" });
});

test("the rules: one contract at a time, one waiting order per contract, the caps count waiting orders, a retry with the same id is the same order", async () => {
  const { engine } = setup();
  ok(await engine.placeLimit("main", buy({ client_order_id: "lim-1" }), "ui"));
  const again = ok(await engine.placeLimit("main", buy({ client_order_id: "lim-1" }), "ui"));
  expect(again.duplicate).toBe(true);
  expect(again.pending).toBeDefined();
  expect(await engine.placeLimit("main", buy({ client_order_id: "lim-1", lots: 2 }), "ui")).toMatchObject({ ok: false, status: 409 });
  expect(await engine.placeLimit("main", buy({ entry: 9370 }), "ui")).toMatchObject({ ok: false, status: 409 }); // already one waiting for this contract
  const held = setup();
  ok(await held.engine.place("main", { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1 }, "ui"));
  expect(await held.engine.placeLimit("main", buy(), "ui")).toMatchObject({ ok: false, status: 409 }); // a position is open in it
  expect(await setup().engine.placeLimit("main", buy({ lots: 3 }), "mcp")).toMatchObject({ ok: false, status: 422 }); // the agent's lot cap
});

test("a waiting order whose contract has been taken meanwhile is cancelled when its price comes, not filled twice", async () => {
  const { engine, store, fut, events } = setup();
  ok(await engine.placeLimit("main", buy(), "ui"));
  ok(await engine.place("main", { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1 }, "ui")); // a market order in the same contract
  fut.q = { price: 9379, bid: 9378, ask: 9379 };
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(1);
  expect(await store.pendingOrders("main")).toHaveLength(0);
  expect(events.at(-1).text).toContain("already in this contract");
});

test("the account state lists the waiting orders, and a reset clears them", async () => {
  const { engine, store } = setup();
  ok(await engine.placeLimit("main", buy(), "ui"));
  const s = ok(await engine.state("main"));
  expect(s.state.pending).toHaveLength(1);
  ok(await engine.reset("main", "ui"));
  expect(await store.pendingOrders("main")).toHaveLength(0);
  expect(ok(await engine.state("main")).state.pending).toEqual([]);
});

test("an option limit buy waits for the premium to fall to it, fills as an option position, and its premium stop works", async () => {
  const { engine, store, opt, events } = setup();
  const r = ok(await engine.placeLimit("main", optBuy({ stop: 400 }), "ui")); // the ask is 501, the limit 480
  expect(r.pending).toMatchObject({ symbol: KEY, entry: 480, units: 100, option: { label: "CRUDEOIL 9600 PE 17 NOV 26", tick: 0.1 } });
  opt.q = { price: 479, bid: 478, ask: 479.5 };
  await engine.onQuotes();
  const [p] = await store.positions("main");
  expect(p).toMatchObject({ symbol: KEY, entry: 479.5, stop: 400, option: { strike: 9600 } });
  expect(p.fill).toMatchObject({ limit: 480, slippageTicks: 0 });
  expect(events.at(-1).text).toContain("bought");
  opt.q = { price: 395, bid: 394, ask: 396 };
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(0);
  expect((await store.trades("main", 1))[0]).toMatchObject({ reason: "stop", option: { strike: 9600 } });
});

test("option limit refusals: an agent, an expired contract, a stop over the entry", async () => {
  expect(await setup().engine.placeLimit("main", optBuy(), "mcp")).toMatchObject({ ok: false, status: 422 });
  const late = setup();
  late.tick(40 * 86_400_000);
  expect(await late.engine.placeLimit("main", optBuy(), "ui")).toMatchObject({ ok: false, status: 422 });
  expect(await setup().engine.placeLimit("main", optBuy({ stop: 490 }), "ui")).toMatchObject({ ok: false, status: 400 });
});

test("the market order path is unchanged: place() still fills at the ask plus slippage", async () => {
  const { engine } = setup();
  const r = ok(await engine.place("main", { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1 }, "ui"));
  expect(r.position.entry).toBe(9402);
});

test("filled: true records a trade already taken, at exactly the entry, whatever the market is now, closed market included", async () => {
  const { engine, opt, fut } = setup();
  const r = ok(await engine.placeLimit("main", optBuy({ entry: 435, filled: true }), "ui")) as any;
  expect(r.position.entry).toBe(435); // the ask is 501: a plain limit would wait
  expect(r.pending).toBeUndefined();
  opt.live = false;
  fut.live = false;
  const f = ok(await engine.placeLimit("main", buy({ entry: 9300, filled: true }), "ui")) as any;
  expect(f.position.entry).toBe(9300);
  // without the flag the same far limit still waits
  const { engine: e2 } = setup();
  expect((ok(await e2.placeLimit("main", optBuy({ entry: 435 }), "ui")) as any).pending).toBeDefined();
});
