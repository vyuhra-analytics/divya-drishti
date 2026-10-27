import { expect, test } from "bun:test";
import { roundTrip, UPSTOX_MCX_RATES } from "./costs";
import { FakeStore } from "./paperFakes";
import type { OptionRef, PaperQuote } from "./paper";
import { isOptionOrder, PaperEngine, parseOptionOrder } from "./paperServer";

// Option paper trading (buy only): the premium fills at the ask plus slippage in premium ticks, stops and targets are on the premium, costs use the option rates,
// and the contract's own liveness and price step apply. Over a fake store and fake feeds.
const KEY = "MCX_FO|583810";
const NOW = Date.parse("2026-10-28T10:00:00Z");
const info: OptionRef & { lot: number; expiresAt: number } = { key: KEY, label: "CRUDEOIL 9600 PE 17 NOV 26", underlying: "CRUDEOIL", type: "PE", strike: 9600, expiry: "2026-11-17", tick: 0.1, lot: 100, expiresAt: Date.parse("2026-11-17T18:00:00Z") };

function setup(opts: { live?: boolean; quote?: PaperQuote | undefined } = {}) {
  const store = new FakeStore();
  const opt: { quote: PaperQuote | undefined; live: boolean; known: boolean } = { quote: "quote" in opts ? opts.quote : { price: 500, bid: 499.5, ask: 501 }, live: opts.live ?? true, known: true };
  let n = 0;
  let t = NOW;
  const events: any[] = [];
  const engine = new PaperEngine({
    store,
    quote: () => undefined,
    live: () => false, // the futures feed is not what an option fills on
    option: { info: async (k) => (opt.known && k === KEY ? info : undefined), quote: () => opt.quote, live: () => opt.live },
    rates: async () => UPSTOX_MCX_RATES,
    now: () => t,
    newId: () => `o${++n}`,
    publish: (e) => void events.push(e),
  });
  return { engine, store, opt, events, tick: (ms: number) => (t += ms) };
}
const order = (over: object = {}) => ({ option: { key: KEY }, side: "buy", lots: 1, ...over });

test("an option order is told apart and parsed strictly: buy only, a real key, whole lots, positive premiums", () => {
  expect(isOptionOrder(order())).toBe(true);
  expect(isOptionOrder({ symbol: "MCX:CRUDEOIL", side: "buy", lots: 1 })).toBe(false);
  expect(parseOptionOrder(order({ stop: 450, target: "600" }))).toEqual({ order: { key: KEY, lots: 1, stop: 450, target: 600 } });
  expect(parseOptionOrder(order({ side: "sell" }))).toEqual({ error: "option paper trading is buy only: the strategies buy calls and puts" });
  expect("error" in parseOptionOrder(order({ option: { key: "MCX:CRUDEOIL" } }))).toBe(true);
  expect("error" in parseOptionOrder(order({ option: { key: "MCX_FO|1; DROP" } }))).toBe(true);
  expect("error" in parseOptionOrder(order({ lots: 0 }))).toBe(true);
  expect("error" in parseOptionOrder(order({ lots: 1.5 }))).toBe(true);
  expect("error" in parseOptionOrder(order({ stop: -1 }))).toBe(true);
  expect("error" in parseOptionOrder(order({ stop: true }))).toBe(true);
});

test("buying fills at the ask plus slippage in PREMIUM ticks, in the contract's lot, and records the option", async () => {
  const { engine, store } = setup();
  const r = await engine.place("main", order({ stop: 450, target: 600 }), "ui");
  if (!r.ok) throw new Error(r.error);
  expect(r.position.entry).toBeCloseTo(501.1, 6); // the ask 501 + 1 tick of 0.1
  expect(r.position).toMatchObject({ symbol: KEY, side: "buy", lots: 1, units: 100, stop: 450, target: 600, actor: "ui" });
  expect(r.position.option).toMatchObject({ key: KEY, type: "PE", strike: 9600, tick: 0.1, label: "CRUDEOIL 9600 PE 17 NOV 26" });
  expect(r.position.fill).toMatchObject({ reference: 501, slippageTicks: 1 });
  expect((await store.positions("main"))[0].id).toBe(r.position.id);
  expect(store.log.at(-1)).toMatchObject({ action: "place", ok: true });
  expect(store.log.at(-1)!.detail).toContain("CRUDEOIL 9600 PE 17 NOV 26");
});

test("closing sells at the bid minus slippage and charges the OPTION costs, not the futures ones", async () => {
  const { engine, opt } = setup();
  const r = await engine.place("main", order(), "ui");
  if (!r.ok) throw new Error(r.error);
  opt.quote = { price: 540, bid: 539, ask: 541 };
  const c = await engine.close("main", r.position.id, "ui");
  if (!c.ok) throw new Error(c.error);
  expect(c.trade.exit).toBeCloseTo(538.9, 6); // the bid 539 less one tick
  const expected = roundTrip("option", "buy", 501.1, 538.9, 100, 1);
  expect(c.trade.gross).toBeCloseTo(expected.gross, 6);
  expect(c.trade.costs).toBeCloseTo(expected.costs.total, 6);
  expect(c.trade.costs).not.toBeCloseTo(roundTrip("future", "buy", 501.1, 538.9, 100, 1).costs.total, 2); // option CTT and exchange charge differ
  expect(c.trade.option?.strike).toBe(9600);
  expect(c.trade.exitFill).toMatchObject({ reference: 539, slippageTicks: 1 });
});

test("the open P&L is marked at the option's own quote", async () => {
  const { engine, opt } = setup();
  await engine.place("main", order(), "ui");
  opt.quote = { price: 520, bid: 519, ask: 521 };
  const s = await engine.state("main");
  if (!s.ok) throw new Error(s.error);
  const net = roundTrip("option", "buy", 501.1, 518.9, 100, 1).net;
  expect(s.state.summary.unrealised).toBeCloseTo(net, 6);
});

test("a stop and a target on the premium fire on the option's live ticks, and not when its quote is stale", async () => {
  const { engine, opt, store } = setup();
  const r = await engine.place("main", order({ stop: 480, target: 560 }), "ui");
  if (!r.ok) throw new Error(r.error);
  opt.quote = { price: 470, bid: 469, ask: 471 };
  opt.live = false;
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(1); // not live: nothing fires
  opt.live = true;
  await engine.onQuotes();
  expect(await store.positions("main")).toHaveLength(0);
  const t = (await store.trades("main", 1))[0];
  expect(t).toMatchObject({ reason: "stop", closedBy: "engine" });
  expect(t.exit).toBeCloseTo(468.9, 6);
});

test("a stop must be under the fill and a target over it (premium), with the engine's own words", async () => {
  const { engine } = setup();
  const bad = await engine.place("main", order({ stop: 510 }), "ui");
  expect(bad).toMatchObject({ ok: false, status: 400 });
  expect(bad.ok === false && bad.error).toContain("501.1");
});

test("refusals: no premium yet, a stale or closed market, an unknown or expired contract, an agent, a repeat contract", async () => {
  expect(await setup({ quote: undefined }).engine.place("main", order(), "ui")).toMatchObject({ ok: false, status: 503 });
  expect(await setup({ live: false }).engine.place("main", order(), "ui")).toMatchObject({ ok: false, status: 503 });
  const unknown = setup();
  unknown.opt.known = false;
  expect(await unknown.engine.place("main", order(), "ui")).toMatchObject({ ok: false, status: 404 });
  const late = setup();
  late.tick(40 * 86_400_000);
  const expired = await late.engine.place("main", order(), "ui");
  expect(expired).toMatchObject({ ok: false, status: 422 });
  expect(expired.ok === false && expired.error).toContain("expired");
  expect(await setup().engine.place("main", order(), "mcp")).toMatchObject({ ok: false, status: 422 }); // browser only for now
  const twice = setup();
  await twice.engine.place("main", order(), "ui");
  expect(await twice.engine.place("main", order(), "ui")).toMatchObject({ ok: false, status: 409 });
  const noOptions = new PaperEngine({ store: new FakeStore(), quote: () => undefined, live: () => true, rates: async () => UPSTOX_MCX_RATES, now: () => NOW, newId: () => "x", publish: () => undefined });
  expect(await noOptions.place("main", order(), "ui")).toMatchObject({ ok: false, status: 503 });
});

test("a repeat of a client_order_id answers with the original position and does not fill twice", async () => {
  const { engine, store } = setup();
  const a = await engine.place("main", order({ client_order_id: "opt-1" }), "ui");
  const b = await engine.place("main", order({ client_order_id: "opt-1" }), "ui");
  if (!a.ok || !b.ok) throw new Error("expected both to answer");
  expect(b.duplicate).toBe(true);
  expect(b.position.id).toBe(a.position.id);
  expect(await store.positions("main")).toHaveLength(1);
  expect(await engine.place("main", order({ client_order_id: "opt-1", lots: 2 }), "ui")).toMatchObject({ ok: false, status: 409 });
});

test("a futures order still works beside an option position, and the two never share a contract", async () => {
  const store = new FakeStore();
  const engine = new PaperEngine({
    store,
    quote: (s) => (s === "MCX:CRUDEOIL" ? { price: 9400, bid: 9399, ask: 9401 } : undefined),
    live: () => true,
    option: { info: async () => info, quote: () => ({ price: 500, bid: 499.5, ask: 501 }), live: () => true },
    rates: async () => UPSTOX_MCX_RATES,
    now: () => NOW,
    newId: (() => { let n = 0; return () => `m${++n}`; })(),
    publish: () => undefined,
  });
  expect((await engine.place("main", order(), "ui")).ok).toBe(true);
  const fut = await engine.place("main", { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1 }, "ui");
  expect(fut.ok).toBe(true);
  expect((await store.positions("main")).map((p) => [p.symbol, !!p.option])).toEqual([[KEY, true], ["MCX:CRUDEOIL", false]]);
});
