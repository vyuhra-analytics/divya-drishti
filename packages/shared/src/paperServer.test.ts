import { expect, test } from "bun:test";
import { roundTrip, UPSTOX_MCX_RATES } from "./costs";
import type { PaperPosition, PaperQuote, PaperTrade } from "./paper";
import { PaperEngine, parseOrderInput, parseRates, parseStopTarget, tickSize, type AccountRow, type AuditEntry, type PaperStore } from "./paperServer";

class FakeStore implements PaperStore {
  accounts = new Map<string, AccountRow>([["main", { id: "main", capital: 500_000, slippage: 1 }]]);
  pos = new Map<string, { account: string; position: PaperPosition }>();
  tr: { account: string; trade: PaperTrade }[] = [];
  log: AuditEntry[] = [];
  async listAccounts() {
    return [...this.accounts.values()];
  }
  async getAccount(id: string) {
    return this.accounts.get(id);
  }
  async saveAccount(a: AccountRow) {
    this.accounts.set(a.id, a);
  }
  async deleteAccount(id: string) {
    this.accounts.delete(id);
    await this.reset(id);
  }
  async positions(account: string) {
    return [...this.pos.values()].filter((x) => x.account === account).map((x) => x.position);
  }
  async allPositions() {
    return [...this.pos.values()];
  }
  async savePosition(account: string, p: PaperPosition) {
    this.pos.set(p.id, { account, position: p });
  }
  async deletePosition(_account: string, id: string) {
    this.pos.delete(id);
  }
  async trades(account: string, limit: number) {
    return this.tr.filter((x) => x.account === account).map((x) => x.trade).reverse().slice(0, limit);
  }
  async saveTrade(account: string, trade: PaperTrade) {
    this.tr.push({ account, trade });
  }
  async setNote(account: string, id: string, note: string) {
    const t = this.tr.find((x) => x.account === account && x.trade.id === id);
    if (!t) return false;
    t.trade.note = note;
    return true;
  }
  async reset(account: string) {
    for (const [id, x] of this.pos) if (x.account === account) this.pos.delete(id);
    this.tr = this.tr.filter((x) => x.account !== account);
  }
  async ordersSince(account: string, actor: string, since: number) {
    return this.log.filter((e) => e.account === account && e.actor === actor && e.action === "place" && e.ok && e.at >= since).length;
  }
  async audit(e: AuditEntry) {
    this.log.push(e);
  }
}

function setup(opts: { live?: boolean } = {}) {
  const store = new FakeStore();
  const quotes: Record<string, PaperQuote> = { "MCX:CRUDEOIL": { price: 9400, bid: 9399, ask: 9401 }, "MCX:NATURALGAS": { price: 270, bid: 269.9, ask: 270.1 } };
  let live = opts.live ?? true;
  let n = 0;
  let t = 1_800_000_000_000;
  const events: any[] = [];
  const engine = new PaperEngine({
    store,
    quote: (s) => quotes[s],
    live: () => live,
    rates: async () => UPSTOX_MCX_RATES,
    now: () => t,
    newId: () => `p${++n}`,
    publish: (e) => void events.push(e),
  });
  return { engine, store, quotes, events, setLive: (v: boolean) => (live = v), tick: (ms: number) => (t += ms) };
}

const order = (over: object = {}) => ({ symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, ...over });

test("parseOrderInput and parseStopTarget refuse anything unexpected with a reason", () => {
  expect(parseOrderInput(order({ stop: "9380" }))).toEqual({ order: { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, stop: 9380, target: undefined } });
  for (const bad of [null, {}, order({ symbol: "NYMEX:CL" }), order({ symbol: "DOGE" }), order({ side: "long" }), order({ lots: 0 }), order({ lots: 1.5 }), order({ lots: "x" }), order({ stop: -1 }), order({ target: "abc" })]) {
    expect("error" in parseOrderInput(bad)).toBe(true);
  }
  expect(parseStopTarget({ stop: 9380 })).toEqual({ stop: 9380 });
  expect(parseStopTarget({ stop: null, target: 9500 })).toEqual({ stop: null, target: 9500 });
  for (const bad of [{}, null, { stop: -5 }, { stop: "x" }, { target: true }]) expect("error" in (parseStopTarget(bad) as object)).toBe(true);
});

test("an order fills at the ask plus slippage, is saved, audited and announced to open browsers", async () => {
  const { engine, store, events } = setup();
  const r = await engine.place("main", order({ stop: 9380 }), "ui");
  expect(r.ok && r.position).toMatchObject({ symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, entry: 9402, stop: 9380, actor: "ui" });
  expect((await store.positions("main")).length).toBe(1);
  expect(store.log[0]).toMatchObject({ actor: "ui", action: "place", ok: true });
  expect(events[0]).toMatchObject({ account: "main", event: "opened", actor: "ui" });
  expect(events[0].text).toContain("You opened 1 lot MCX:CRUDEOIL long at 9402");
});

test("an order from an agent is announced as Claude's and tagged mcp", async () => {
  const { engine, events } = setup();
  const r = await engine.place("main", order(), "mcp");
  expect(r.ok && r.position.actor).toBe("mcp");
  expect(events[0].text).toContain("Claude opened");
});

test("the agent's caps are enforced by the server: lots, open positions and orders per day", async () => {
  const { engine, tick } = setup();
  const big = await engine.place("main", order({ lots: 3 }), "mcp");
  expect(big).toMatchObject({ ok: false, status: 422 });
  expect((await engine.place("main", order({ lots: 3 }), "ui")).ok).toBe(true); // the same order from the UI is fine
  const { engine: e2 } = setup();
  expect((await e2.place("main", order({ symbol: "MCX:CRUDEOIL" }), "mcp")).ok).toBe(true);
  expect((await e2.place("main", order({ symbol: "MCX:NATURALGAS" }), "mcp")).ok).toBe(true);
  // daily order cap: 20 in 24 hours, counted from the audit log
  const c = setup();
  for (let i = 0; i < 20; i++) {
    const r = await c.engine.place("main", order(), "mcp");
    expect(r.ok).toBe(true);
    await c.engine.close("main", (r as any).position.id, "mcp");
  }
  const over = await c.engine.place("main", order(), "mcp");
  expect(over).toMatchObject({ ok: false, status: 422 });
  expect((over as any).error).toContain("at most 20 orders");
  c.tick(86_400_001 + tick(0)); // a day later the window has moved on
  expect((await c.engine.place("main", order(), "mcp")).ok).toBe(true);
});

test("one position per contract, no price, closed market and unknown account are all refused", async () => {
  const { engine, quotes, setLive } = setup();
  expect((await engine.place("main", order(), "ui")).ok).toBe(true);
  expect(await engine.place("main", order(), "ui")).toMatchObject({ ok: false, status: 409 });
  expect(await engine.place("nope", order(), "ui")).toMatchObject({ ok: false, status: 404 });
  delete quotes["MCX:NATURALGAS"];
  expect(await engine.place("main", order({ symbol: "MCX:NATURALGAS" }), "ui")).toMatchObject({ ok: false, status: 503 });
  quotes["MCX:CRUDEOILM"] = { price: 9400 };
  setLive(false);
  const closed = await engine.place("main", order({ symbol: "MCX:CRUDEOILM" }), "ui");
  expect(closed).toMatchObject({ ok: false, status: 503 });
  expect((closed as any).error).toContain("market is closed");
  expect(await engine.place("main", order({ lots: 0 }), "ui")).toMatchObject({ ok: false, status: 400 });
});

test("two orders for the same contract at once: exactly one fills", async () => {
  const { engine, store } = setup();
  const [a, b] = await Promise.all([engine.place("main", order(), "ui"), engine.place("main", order(), "mcp")]);
  expect([a.ok, b.ok].sort()).toEqual([false, true]);
  expect((await store.positions("main")).length).toBe(1);
});

test("closing books the trade with full costs, who opened and who closed it, and announces it", async () => {
  const { engine, store, events, quotes } = setup();
  const placed = (await engine.place("main", order(), "mcp")) as any;
  quotes["MCX:CRUDEOIL"] = { price: 9420, bid: 9419, ask: 9421 };
  const r = (await engine.close("main", placed.position.id, "ui")) as any;
  expect(r.ok).toBe(true);
  expect(r.trade).toMatchObject({ entry: 9402, exit: 9418, actor: "mcp", closedBy: "ui", reason: "manual" }); // sold at the bid 9419 less 1 point
  expect(r.trade.net).toBeCloseTo(roundTrip("future", "buy", 9402, 9418, 100, 1).net, 6);
  expect((await store.positions("main")).length).toBe(0);
  expect(events.at(-1).text).toContain("You closed MCX:CRUDEOIL long");
  expect(await engine.close("main", placed.position.id, "ui")).toMatchObject({ ok: false, status: 404 });
});

test("stops and targets can be set, changed and cleared, and must sit on the right side of the entry", async () => {
  const { engine } = setup();
  const p = ((await engine.place("main", order(), "ui")) as any).position;
  const set = (await engine.setStopTarget("main", p.id, { stop: 9380, target: 9450 }, "mcp")) as any;
  expect(set.position).toMatchObject({ stop: 9380, target: 9450 });
  expect(await engine.setStopTarget("main", p.id, { stop: 9410 }, "ui")).toMatchObject({ ok: false, status: 400 }); // above a long's entry
  expect(await engine.setStopTarget("main", p.id, { target: 9390 }, "ui")).toMatchObject({ ok: false, status: 400 });
  const cleared = (await engine.setStopTarget("main", p.id, { stop: null }, "ui")) as any;
  expect(cleared.position.stop).toBeUndefined();
  expect(cleared.position.target).toBe(9450);
  expect(await engine.setStopTarget("main", "nope", { stop: 1 }, "ui")).toMatchObject({ ok: false, status: 404 });
});

test("the engine closes a position at the market when a LIVE price reaches its stop, even one opened by an agent", async () => {
  const { engine, store, events, quotes, setLive } = setup();
  await engine.place("main", order({ stop: 9380 }), "mcp");
  await engine.refresh();
  quotes["MCX:CRUDEOIL"] = { price: 9370, bid: 9369, ask: 9371 }; // gaps through the stop
  setLive(false);
  await engine.onQuotes(); // a stale or closed market triggers nothing
  expect((await store.positions("main")).length).toBe(1);
  setLive(true);
  await engine.onQuotes();
  expect((await store.positions("main")).length).toBe(0);
  const t = (await store.trades("main", 1))[0]!;
  expect(t).toMatchObject({ reason: "stop", exit: 9368, actor: "mcp", closedBy: "engine" }); // the bid less 1 point, not the 9380 stop
  expect(events.at(-1).text).toMatch(/^Stop hit: MCX:CRUDEOIL long, net -₹/);
  await engine.onQuotes(); // nothing left to do
});

test("state marks open P&L at the live quote and summarises realised results", async () => {
  const { engine, quotes } = setup();
  await engine.place("main", order(), "ui");
  quotes["MCX:CRUDEOIL"] = { price: 9500, bid: 9499, ask: 9501 };
  const s = ((await engine.state("main")) as any).state;
  expect(s.positions).toHaveLength(1);
  expect(s.summary.unrealised).toBeCloseTo(roundTrip("future", "buy", 9402, 9498, 100, 1).net, 6);
  expect(s.summary.equity).toBeCloseTo(500_000 + s.summary.unrealised, 6);
  expect(s.limits.maxLots).toBe(100);
  expect(((await engine.state("main", "mcp")) as any).state.limits.maxLots).toBe(2); // the agent sees its own caps
  expect(await engine.state("nope")).toMatchObject({ ok: false, status: 404 });
});

test("notes, reset and account management are validated", async () => {
  const { engine, store, events } = setup();
  const p = ((await engine.place("main", order(), "ui")) as any).position;
  const t = ((await engine.close("main", p.id, "ui")) as any).trade;
  expect(await engine.setNote("main", t.id, "followed the plan", "ui")).toEqual({ ok: true });
  expect((await store.trades("main", 1))[0]!.note).toBe("followed the plan");
  expect(await engine.setNote("main", t.id, 42, "ui")).toMatchObject({ ok: false, status: 400 });
  expect(await engine.setNote("main", "nope", "x", "ui")).toMatchObject({ ok: false, status: 404 });
  expect(await engine.createAccount("Bad Id", 1000, 1, "ui")).toMatchObject({ ok: false, status: 400 });
  expect(await engine.createAccount("main", 1000, 1, "ui")).toMatchObject({ ok: false, status: 409 });
  expect(await engine.createAccount("claude", -5, 1, "ui")).toMatchObject({ ok: false, status: 400 });
  expect((await engine.createAccount("claude", 250_000, 1, "ui")).ok).toBe(true);
  expect(((await engine.updateAccount("claude", { capital: 300_000 }, "ui")) as any).account.capital).toBe(300_000);
  expect(await engine.updateAccount("claude", { slippage: -1 }, "ui")).toMatchObject({ ok: false, status: 400 });
  await engine.reset("main", "ui");
  expect(await store.trades("main", 10)).toEqual([]);
  expect(events.at(-1)).toMatchObject({ event: "reset", account: "main" });
});

test("the audit log records every write with who, what and the outcome, refusals included", async () => {
  const { engine, store } = setup();
  await engine.place("main", order({ lots: 9 }), "mcp"); // over the agent's cap
  const placed = ((await engine.place("main", order(), "mcp")) as any).position;
  await engine.close("main", placed.id, "mcp");
  expect(store.log.map((e) => [e.actor, e.action, e.ok])).toEqual([
    ["mcp", "place", false],
    ["mcp", "place", true],
    ["mcp", "close", true],
  ]);
  expect(store.log[0]!.detail).toContain("at most 2 lots");
});

test("parseRates accepts a partial set, keeps the rest at the defaults and refuses nonsense", () => {
  const ok = parseRates({ brokerageFlat: 25, exchangeFutures: 0.000026 }) as any;
  expect(ok.rates).toEqual({ ...UPSTOX_MCX_RATES, brokerageFlat: 25, exchangeFutures: 0.000026 });
  for (const bad of [null, "x", { gst: 5 }, { cttFutures: -1 }, { sebi: "abc" }, { exchangeFutures: 3 }, { gst: true }]) expect("error" in (parseRates(bad) as object)).toBe(true);
});

test("importing the browser's old account fills an empty server account, keeps only well-formed rows, and refuses a second time", async () => {
  const { engine, store, events } = setup();
  const trade = (id: string, over: object = {}) => ({ id, symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, units: 100, entry: 9400, exit: 9410, openedAt: 1, closedAt: 2, gross: 1000, costs: 210, net: 790, reason: "manual", note: "kept", ...over });
  const data = {
    capital: 600_000,
    slippage: 2,
    positions: [{ id: "a", symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, units: 100, entry: 9400, openedAt: 5, stop: 9380 }, { id: "b", symbol: "DOGE", side: "buy", lots: 1, units: 1, entry: 1, openedAt: 1 }],
    trades: [trade("t1"), trade("t2", { net: "x" }), trade("t3", { symbol: "NYMEX:CL" }), trade("t4", { note: "n".repeat(900) })],
  };
  const r = (await engine.importLegacy("main", data, "ui")) as any;
  expect(r).toMatchObject({ ok: true, positions: 1, trades: 2 });
  expect((await store.positions("main"))[0]).toMatchObject({ id: "legacy-a", stop: 9380, actor: "ui" });
  expect((await store.trades("main", 10)).map((t) => t.id).sort()).toEqual(["legacy-t1", "legacy-t4"]);
  expect((await store.trades("main", 10)).find((t) => t.id === "legacy-t4")!.note.length).toBe(500);
  expect((await store.getAccount("main"))).toMatchObject({ capital: 600_000, slippage: 2 });
  expect(events.at(-1).event).toBe("imported");
  expect(await engine.importLegacy("main", data, "ui")).toMatchObject({ ok: false, status: 409 });
});

test("slippage is in ticks: one tick is 1 rupee on crude and 0.1 on natural gas, so a round trip costs the same number of ticks on both", async () => {
  expect(tickSize("MCX:CRUDEOIL")).toBe(1);
  expect(tickSize("MCX:NATURALGAS")).toBe(0.1);
  const { engine } = setup();
  const gas = ((await engine.place("main", order({ symbol: "MCX:NATURALGAS", side: "sell" }), "ui")) as any).position;
  expect(gas.entry).toBeCloseTo(269.9 - 0.1, 9); // sold at the bid 269.9, one tick (0.1) worse, not a full rupee
  const crude = ((await engine.place("main", order(), "ui")) as any).position;
  expect(crude.entry).toBe(9402); // the ask 9401 plus one tick (1)
});

test("an account can be deleted with its contents, but never main", async () => {
  const { engine, store } = setup();
  await engine.createAccount("claude", 100_000, 1, "ui");
  await engine.place("claude", order(), "ui");
  await engine.refresh();
  expect(await engine.deleteAccount("main", "ui")).toMatchObject({ ok: false, status: 409 });
  expect(await engine.deleteAccount("nope", "ui")).toMatchObject({ ok: false, status: 404 });
  expect(await engine.deleteAccount("claude", "ui")).toEqual({ ok: true });
  expect(await store.getAccount("claude")).toBeUndefined();
  expect((await store.positions("claude")).length).toBe(0);
  expect(await engine.place("claude", order(), "ui")).toMatchObject({ ok: false, status: 404 });
});
