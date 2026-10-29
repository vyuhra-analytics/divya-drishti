// Server-side paper trading: accounts, positions and the trade journal kept in Postgres and driven by the stream service, so a paper trade
// can be placed from the browser OR by an agent over MCP and both see the same account. The engine is plain logic over injected
// dependencies (store, quotes, clock, publisher), tested with fakes; the stream wires it to Postgres and the live quotes.
// Nothing in here can reach a broker: orders are simulated fills on live quotes, like paper.ts.
import { UPSTOX_MCX_RATES, type CostRates, type Side } from "./costs";
import { lotUnits } from "./costs";
import { instrument } from "./index";
import { closePaper, describeFill, describeLimitFill, exitHit, limitFill, openPaper, summarizeAccount, unrealisedNet, type Account, type ExitReason, type ManagePlan, type OptionRef, type OrderMeta, type PaperPosition, type PaperQuote, type PaperTrade, type PendingOrder } from "./paper";

export type Actor = "ui" | "mcp";

export interface Limits {
  maxLots: number;
  maxOpenPositions: number;
  /** orders placed by this actor in the last 24 hours */
  maxOrdersPerDay: number;
}

/** What each kind of caller may do. The agent's caps are tight and enforced here, where the agent cannot change them. */
export const DEFAULT_LIMITS: Record<Actor, Limits> = {
  ui: { maxLots: 100, maxOpenPositions: 8, maxOrdersPerDay: 500 },
  mcp: { maxLots: 2, maxOpenPositions: 4, maxOrdersPerDay: 20 },
};

export const MAX_NOTE = 500;
export const MAX_TRADES_KEPT = 500;
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Price step of a contract (crude 1, natural gas 0.1): from the instrument's decimals. */
export const tickSize = (symbol: string) => 10 ** -(instrument(symbol)?.decimals ?? 2);

export interface AccountRow {
  id: string;
  capital: number;
  /** slippage in TICKS of the contract, so "1" means one price step on crude and on gas alike (a fixed number of points would be 10 ticks on gas) */
  slippage: number;
}

export interface OrderInput extends OrderMeta {
  symbol: string;
  side: Side;
  lots: number;
  stop?: number;
  target?: number;
  /** a limit price: the order waits for the market to reach it (absent = at the market) */
  entry?: number;
  /** what the engine does by itself once filled (see ManagePlan); market orders only */
  plan?: ManagePlan;
}

/** `plan: { tp1, close_at }` on an order: tp1 a positive price, close_at an ISO 8601 time. Absent means no plan. */
export function parsePlan(body: any): { plan?: ManagePlan } | { error: string } {
  const raw = body?.plan;
  if (raw === undefined || raw === null) return {};
  const tp1 = typeof raw.tp1 === "number" ? raw.tp1 : NaN;
  const closeAt = typeof raw.close_at === "string" ? Date.parse(raw.close_at) : NaN;
  if (!Number.isFinite(tp1) || tp1 <= 0) return { error: "plan.tp1 must be a positive price" };
  if (!Number.isFinite(closeAt)) return { error: "plan.close_at must be an ISO 8601 time" };
  return { plan: { tp1, closeAt } };
}

/** Does the order name an entry price (a limit order)? */
export const hasEntry = (body: unknown): boolean => {
  const v = typeof body === "object" && body !== null ? (body as { entry?: unknown }).entry : undefined;
  return v !== undefined && v !== null && v !== "";
};

/** The limit price of an order: a positive number, or undefined when absent. */
function parseEntry(v: unknown): number | undefined | Error {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean" || !Number.isFinite(Number(v)) || Number(v) <= 0) return new Error("entry must be a positive price, or left out to trade at the market");
  return Number(v);
}

const CLIENT_ORDER_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const LABEL = /^[^\u0000-\u001f<>]{1,64}$/;

/** The labels on an order: client_order_id, tag, strategy, signal_time (an ISO time) and r_points. Each optional; anything present must be well-formed. */
export function parseOrderMeta(body: any): { meta: OrderMeta } | { error: string } {
  const absent = (v: unknown) => v === undefined || v === null || v === "";
  const meta: OrderMeta = {};
  if (!absent(body?.client_order_id)) {
    if (typeof body.client_order_id !== "string" || !CLIENT_ORDER_ID.test(body.client_order_id)) return { error: "client_order_id must be 1 to 64 letters, digits, . _ : or -" };
    meta.clientOrderId = body.client_order_id;
  }
  for (const [key, field] of [["tag", "tag"], ["strategy", "strategy"]] as const) {
    if (absent(body?.[key])) continue;
    if (typeof body[key] !== "string" || !LABEL.test(body[key].trim())) return { error: `${key} must be 1 to 64 characters of plain text` };
    meta[field] = body[key].trim();
  }
  if (!absent(body?.signal_time)) {
    const t = typeof body.signal_time === "string" ? Date.parse(body.signal_time) : NaN;
    if (!Number.isFinite(t)) return { error: "signal_time must be an ISO 8601 time, e.g. 2026-10-22T09:30:00+05:30" };
    meta.signalTime = t;
  }
  if (!absent(body?.r_points)) {
    const r = typeof body.r_points === "number" ? body.r_points : NaN;
    if (!Number.isFinite(r) || r <= 0 || r > 1e6) return { error: "r_points must be a positive number of price points" };
    meta.rPoints = r;
  }
  return { meta };
}

/** Validate an order from a request body or a tool call: refuse anything unexpected with a reason, never coerce. */
export function parseOrderInput(body: any): { order: OrderInput } | { error: string } {
  const symbol = body?.symbol;
  const inst = typeof symbol === "string" ? instrument(symbol) : undefined;
  if (!inst || inst.exchange !== "MCX" || lotUnits(symbol) === undefined) return { error: "symbol must be an MCX contract (MCX:CRUDEOIL, MCX:CRUDEOILM, MCX:NATURALGAS or MCX:NATGASMINI): costs follow Upstox's MCX schedule" };
  if (body.side !== "buy" && body.side !== "sell") return { error: "side must be buy or sell" };
  const lots = Number(body.lots);
  if (!Number.isInteger(lots) || lots < 1) return { error: "lots must be a whole number of at least 1" };
  const num = (v: unknown, name: string) => (v === undefined || v === null || v === "" ? undefined : Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : (() => { throw new Error(`${name} must be a positive price`); })());
  const m = parseOrderMeta(body);
  if ("error" in m) return m;
  const pl = parsePlan(body);
  if ("error" in pl) return pl;
  try {
    const entry = parseEntry(body.entry);
    if (entry instanceof Error) return { error: entry.message };
    if (pl.plan && entry !== undefined) return { error: "plan is for market orders: a limit order cannot carry one" };
    return { order: { symbol, side: body.side, lots, stop: num(body.stop, "stop"), target: num(body.target, "target"), ...(entry !== undefined ? { entry } : {}), ...m.meta, ...(pl.plan ? { plan: pl.plan } : {}) } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** An Upstox option instrument key. */
export const PAPER_OPTION_KEY = /^MCX_FO\|\d{3,9}$/;

export interface OptionOrderInput extends OrderMeta {
  key: string;
  lots: number;
  stop?: number;
  target?: number;
  /** a limit premium: the order waits for the option's ask to fall to it */
  entry?: number;
}

/** An order carries an `option` when it is an option order: { option: { key }, side: "buy", lots, stop?, target? } with stop and target in PREMIUM. Option paper trading is buy only. */
export const isOptionOrder = (body: unknown): boolean => typeof body === "object" && body !== null && (body as { option?: unknown }).option !== undefined;

export function parseOptionOrder(body: any): { order: OptionOrderInput } | { error: string } {
  const key = body?.option?.key;
  if (typeof key !== "string" || !PAPER_OPTION_KEY.test(key)) return { error: "option.key must be an Upstox instrument key like MCX_FO|583805" };
  if (body.side !== "buy") return { error: "option paper trading is buy only: the strategies buy calls and puts" };
  const lots = Number(body.lots);
  if (!Number.isInteger(lots) || lots < 1) return { error: "lots must be a whole number of at least 1" };
  const price = (v: unknown, name: string) => {
    if (v === undefined || v === null || v === "") return undefined;
    if (!Number.isFinite(Number(v)) || Number(v) <= 0 || typeof v === "boolean") throw new Error(`${name} must be a positive premium`);
    return Number(v);
  };
  const m = parseOrderMeta(body);
  if ("error" in m) return m;
  try {
    const entry = parseEntry(body.entry);
    if (entry instanceof Error) return { error: entry.message };
    return { order: { key, lots, stop: price(body.stop, "stop"), target: price(body.target, "target"), ...(entry !== undefined ? { entry } : {}), ...m.meta } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A stop/target change: a number sets it, null clears it, absent leaves it alone. `only_tighten` makes it a trailing update that can only move the stop closer to profit. */
export function parseStopTarget(body: any): { stop?: number | null; target?: number | null; onlyTighten?: boolean; reason?: string } | { error: string } {
  const out: { stop?: number | null; target?: number | null; onlyTighten?: boolean; reason?: string } = {};
  for (const k of ["stop", "target"] as const) {
    if (!(k in (body ?? {}))) continue;
    const v = body[k];
    if (v === null) out[k] = null;
    else if (Number.isFinite(Number(v)) && Number(v) > 0 && v !== "" && v !== true) out[k] = Number(v);
    else return { error: `${k} must be a positive price, or null to remove it` };
  }
  if (!("stop" in out) && !("target" in out)) return { error: "give a stop and/or a target (null removes one)" };
  if (body?.only_tighten !== undefined) {
    if (typeof body.only_tighten !== "boolean") return { error: "only_tighten must be true or false" };
    out.onlyTighten = body.only_tighten;
  }
  if (body?.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || body.reason.length > 120) return { error: "reason must be text of at most 120 characters" };
    out.reason = body.reason;
  }
  return out;
}

/** Cost rates from a request body: every rate present must be a finite number of at least 0 (GST at most 1); missing ones keep the Upstox defaults. */
export function parseRates(body: any): { rates: CostRates } | { error: string } {
  if (!body || typeof body !== "object") return { error: "send the cost rates as a JSON object" };
  const rates: CostRates = { ...UPSTOX_MCX_RATES };
  for (const k of Object.keys(UPSTOX_MCX_RATES) as (keyof CostRates)[]) {
    if (!(k in body)) continue;
    const v = Number(body[k]);
    if (typeof body[k] === "boolean" || body[k] === "" || !Number.isFinite(v) || v < 0 || (k === "gst" && v > 1) || (k !== "brokerageFlat" && v > 0.1)) return { error: `${k} is not a sensible rate` };
    rates[k] = v;
  }
  return { rates };
}

export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  account: string;
  args: unknown;
  ok: boolean;
  detail: string;
}

export interface PaperStore {
  listAccounts(): Promise<AccountRow[]>;
  getAccount(id: string): Promise<AccountRow | undefined>;
  saveAccount(a: AccountRow): Promise<void>;
  /** removes the account with its positions and trades */
  deleteAccount(id: string): Promise<void>;
  positions(account: string): Promise<PaperPosition[]>;
  allPositions(): Promise<{ account: string; position: PaperPosition }[]>;
  savePosition(account: string, p: PaperPosition): Promise<void>;
  deletePosition(account: string, id: string): Promise<void>;
  trades(account: string, limit: number): Promise<PaperTrade[]>;
  saveTrade(account: string, t: PaperTrade): Promise<void>;
  setNote(account: string, tradeId: string, note: string): Promise<boolean>;
  reset(account: string): Promise<void>;
  /** limit orders waiting for their price */
  pendingOrders(account: string): Promise<PendingOrder[]>;
  allPending(): Promise<{ account: string; order: PendingOrder }[]>;
  savePending(account: string, o: PendingOrder): Promise<void>;
  deletePending(account: string, id: string): Promise<void>;
  /** orders placed by `actor` on `account` since `sinceMs` (from the audit log) */
  ordersSince(account: string, actor: string, sinceMs: number): Promise<number>;
  audit(e: AuditEntry): Promise<void>;
}

export interface PaperDeps {
  store: PaperStore;
  quote(symbol: string): PaperQuote | undefined;
  /** the exchange is open and the feed was heard from in the last minute */
  live(symbol: string): boolean;
  /** option contracts (paper option trading): what a key is, its live premium quote, and whether that quote may be filled on */
  option?: {
    info(key: string): Promise<(OptionRef & { lot: number; expiresAt: number }) | undefined>;
    quote(key: string): PaperQuote | undefined;
    live(key: string): boolean;
    /** ask the feed to watch a contract (a browser does this by picking a strike; an agent cannot) */
    watch?(key: string): void;
  };
  rates(): Promise<CostRates>;
  now(): number;
  newId(): string;
  /** told after every change, so open browsers refresh: { account, event, actor, text } */
  publish(e: { account: string; event: "opened" | "closed" | "updated" | "reset" | "imported"; actor: string; text: string }): void;
  limits?: Record<Actor, Limits>;
}

/** What placing an order answers: the position, and when the caller's client_order_id was already used, `duplicate` (and the closing trade if it has since closed). */
export interface PlaceResult {
  position: PaperPosition;
  duplicate?: true;
  closed?: PaperTrade;
}

/** What a limit order answers: filled at once (the market was already at its price), or waiting. */
export interface LimitResult {
  position?: PaperPosition;
  pending?: PendingOrder;
  duplicate?: true;
}

/** How long a limit order waits before it is cancelled. */
export const PENDING_TTL_MS = 24 * 3600_000;

export type Result<T> = ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409 | 422 | 503; error: string };
const fail = (status: 400 | 404 | 409 | 422 | 503, error: string) => ({ ok: false as const, status, error });

export interface AccountState {
  account: AccountRow;
  positions: PaperPosition[];
  /** limit orders waiting for their price */
  pending: PendingOrder[];
  trades: PaperTrade[];
  rates: CostRates;
  limits: Limits;
  summary: Account;
}

export class PaperEngine {
  private open = new Map<string, { account: string; position: PaperPosition }>();
  private waiting = new Map<string, { account: string; order: PendingOrder }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: PaperDeps) {}

  private limits(actor: Actor): Limits {
    return (this.d.limits ?? DEFAULT_LIMITS)[actor];
  }

  /** The quote, liveness and price step of a position's contract: the future's, or the option's own. */
  private quoteOf(p: { symbol: string; option?: OptionRef }): PaperQuote | undefined {
    return p.option ? this.d.option?.quote(p.symbol) : this.d.quote(p.symbol);
  }
  private liveOf(p: { symbol: string; option?: OptionRef }): boolean {
    return p.option ? !!this.d.option?.live(p.symbol) : this.d.live(p.symbol);
  }
  private tickOf(p: { symbol: string; option?: OptionRef }): number {
    return p.option?.tick ?? tickSize(p.symbol);
  }

  /** Run one change at a time: two orders or a stop firing during an order must not see half-written state. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** An option past its last trading minute (23:30 IST on its expiry day, as the order check uses). */
  private expired(p: PaperPosition): boolean {
    return !!p.option && this.d.now() >= Date.parse(`${p.option.expiry}T23:30:00+05:30`);
  }

  /** The Upstox keys of the option positions that are open: the stream keeps their quotes coming so stops fire with the browser closed. */
  openOptionKeys(): string[] {
    return [...this.open.values()].filter((x) => x.position.option).map((x) => x.position.symbol);
  }

  /** Reload open positions from the database (they are cached so a stop check on every tick costs no query). */
  async refresh() {
    const all = await this.d.store.allPositions();
    this.open = new Map(all.map((x) => [x.position.id, x]));
    this.waiting = new Map((await this.d.store.allPending()).map((x) => [x.order.id, x]));
  }

  private async audit(actor: string, action: string, account: string, args: unknown, r: { ok: boolean; error?: string }, detail = "") {
    await this.d.store.audit({ at: this.d.now(), actor, action, account, args, ok: r.ok, detail: r.ok ? detail : (r as { error: string }).error }).catch(() => undefined);
  }

  async accounts() {
    return this.d.store.listAccounts();
  }

  async createAccount(id: string, capital: number, slippage: number, actor: string): Promise<Result<{ account: AccountRow }>> {
    if (!ACCOUNT_ID.test(id)) return fail(400, "account id must be 1-32 lowercase letters, digits, - or _");
    if (!Number.isFinite(capital) || capital <= 0 || capital > 1e9) return fail(400, "capital must be a positive amount");
    if (!Number.isFinite(slippage) || slippage < 0 || slippage > 1000) return fail(400, "slippage must be 0 or more ticks");
    if (await this.d.store.getAccount(id)) return fail(409, "that account already exists");
    const account = { id, capital, slippage };
    await this.d.store.saveAccount(account);
    await this.audit(actor, "create_account", id, { capital, slippage }, { ok: true });
    return { ok: true, account };
  }

  /** Delete an account and everything in it. The default `main` account is never deleted (reset it instead). */
  deleteAccount(id: string, actor: string): Promise<Result<object>> {
    return this.serial(async () => {
      if (id === "main") return fail(409, "the main account cannot be deleted: reset it instead");
      if (!(await this.d.store.getAccount(id))) return fail(404, "no such account");
      await this.d.store.deleteAccount(id);
      for (const [pid, x] of this.open) if (x.account === id) this.open.delete(pid);
      for (const [pid, x] of this.waiting) if (x.account === id) this.waiting.delete(pid);
      await this.audit(actor, "delete_account", id, {}, { ok: true });
      this.d.publish({ account: id, event: "reset", actor, text: `Account ${id} deleted` });
      return { ok: true };
    });
  }

  async updateAccount(id: string, patch: { capital?: number; slippage?: number }, actor: string): Promise<Result<{ account: AccountRow }>> {
    const a = await this.d.store.getAccount(id);
    if (!a) return fail(404, "no such account");
    const next = { ...a, ...(patch.capital !== undefined ? { capital: patch.capital } : {}), ...(patch.slippage !== undefined ? { slippage: patch.slippage } : {}) };
    if (!Number.isFinite(next.capital) || next.capital <= 0 || next.capital > 1e9) return fail(400, "capital must be a positive amount");
    if (!Number.isFinite(next.slippage) || next.slippage < 0 || next.slippage > 1000) return fail(400, "slippage must be 0 or more ticks");
    await this.d.store.saveAccount(next);
    await this.audit(actor, "update_account", id, patch, { ok: true });
    this.d.publish({ account: id, event: "updated", actor, text: "Account settings changed" });
    return { ok: true, account: next };
  }

  /** The whole account for a client: settings, open positions, recent trades, the cost rates and caps in force, and the summary (open P&L marked at live quotes). */
  async state(id: string, actor: Actor = "ui"): Promise<Result<{ state: AccountState }>> {
    const account = await this.d.store.getAccount(id);
    if (!account) return fail(404, "no such account");
    const [positions, pending, trades, rates] = await Promise.all([this.d.store.positions(id), this.d.store.pendingOrders(id), this.d.store.trades(id, 100), this.d.rates()]);
    const nets = positions.map((p) => {
      const q = this.quoteOf(p);
      return q ? unrealisedNet(p, q, account.slippage * this.tickOf(p), rates) : 0;
    });
    const all = await this.d.store.trades(id, MAX_TRADES_KEPT);
    return { ok: true, state: { account, positions, pending, trades, rates, limits: this.limits(actor), summary: summarizeAccount(account.capital, [...all].reverse(), nets) } };
  }

  place(accountId: string, raw: unknown, actor: Actor): Promise<Result<PlaceResult>> {
    return this.serial(async () => {
      const r = await this.placeNow(accountId, raw, actor);
      // a repeat of an order already filled is recorded under its own action, so it never counts toward the daily order cap
      await this.audit(actor, r.ok && r.duplicate ? "place_duplicate" : "place", accountId, raw, r, r.ok ? `${r.duplicate ? "duplicate of " : ""}${r.position.side} ${r.position.lots} ${r.position.option?.label ?? r.position.symbol} @ ${r.position.entry}` : "");
      if (r.ok && !r.duplicate) this.d.publish({ account: accountId, event: "opened", actor, text: `${actor === "mcp" ? "Claude" : "You"} opened ${r.position.lots} lot${r.position.lots === 1 ? "" : "s"} ${r.position.option?.label ?? r.position.symbol} ${r.position.option ? "bought" : r.position.side === "buy" ? "long" : "short"} at ${r.position.entry}` });
      return r;
    });
  }

  /** An order the caller already placed with this client_order_id: the open position, or (once closed) the position as it was with its trade. */
  private async findClientOrder(accountId: string, clientOrderId: string): Promise<{ position: PaperPosition; trade?: PaperTrade } | undefined> {
    const open = (await this.d.store.positions(accountId)).find((p) => p.clientOrderId === clientOrderId);
    if (open) return { position: open };
    const trade = (await this.d.store.trades(accountId, MAX_TRADES_KEPT)).find((t) => t.clientOrderId === clientOrderId);
    if (!trade) return undefined;
    const { id, symbol, side, lots, units, entry, openedAt, actor, clientOrderId: cid, tag, strategy, signalTime, rPoints, entryFill, option } = trade;
    return { position: { id, symbol, side, lots, units, entry, openedAt, actor, clientOrderId: cid, tag, strategy, signalTime, rPoints, fill: entryFill, ...(option ? { option } : {}) }, trade };
  }

  /** Buy an option on paper: the premium fills at the ask (else the last price) plus slippage in premium ticks, stops and targets are on the premium. Browser only for now. */
  private async placeOptionNow(accountId: string, raw: unknown, actor: Actor): Promise<Result<PlaceResult>> {
    const od = this.d.option;
    if (!od) return fail(503, "option paper trading is not available on this server");
    const parsed = parseOptionOrder(raw);
    if ("error" in parsed) return fail(400, parsed.error);
    const { order } = parsed;
    const account = await this.d.store.getAccount(accountId);
    if (!account) return fail(404, "no such account");
    if (order.clientOrderId) {
      const dup = await this.findClientOrder(accountId, order.clientOrderId);
      if (dup) {
        const p = dup.position;
        if (p.symbol !== order.key || p.lots !== order.lots) return fail(409, `client_order_id ${order.clientOrderId} was already used for a different order`);
        return { ok: true, position: p, duplicate: true, ...(dup.trade ? { closed: dup.trade } : {}) };
      }
    }
    const info = await od.info(order.key);
    if (!info) return fail(404, "that is not an option contract of ours (crude, crude mini, gas or gas mini)");
    if (this.d.now() >= info.expiresAt) return fail(422, `${info.label} has expired`);
    const lim = this.limits(actor);
    if (order.lots > lim.maxLots) return fail(422, `at most ${lim.maxLots} lot${lim.maxLots === 1 ? "" : "s"} per order for this client`);
    const positions = await this.d.store.positions(accountId);
    if (positions.some((p) => p.symbol === order.key)) return fail(409, "already in this contract: close that position first");
    if (positions.length >= lim.maxOpenPositions) return fail(422, `at most ${lim.maxOpenPositions} open positions`);
    if ((await this.d.store.ordersSince(accountId, actor, this.d.now() - 86_400_000)) >= lim.maxOrdersPerDay) return fail(422, `order limit reached: at most ${lim.maxOrdersPerDay} orders in 24 hours`);
    const q = od.quote(order.key);
    if (!q) {
      od.watch?.(order.key);
      return fail(503, "no live premium for this option yet: the feed has been asked to watch it, try again in a few seconds");
    }
    if (!od.live(order.key)) return fail(503, "the market is closed or the feed is stale: paper orders fill only on a live price");
    const ref: OptionRef = { key: info.key, label: info.label, underlying: info.underlying, type: info.type, strike: info.strike, expiry: info.expiry, tick: info.tick };
    const slippage = account.slippage * info.tick;
    const filled = openPaper({ id: this.d.newId(), symbol: order.key, side: "buy", lots: order.lots, units: info.lot, stop: order.stop, target: order.target }, q, slippage, this.d.now());
    if ("error" in filled) return fail(400, filled.error);
    const position: PaperPosition = {
      ...filled,
      actor,
      option: ref,
      fill: describeFill("buy", q, slippage, info.tick),
      ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
      ...(order.tag ? { tag: order.tag } : {}),
      ...(order.strategy ? { strategy: order.strategy } : {}),
      ...(order.signalTime !== undefined ? { signalTime: order.signalTime } : {}),
      ...(order.rPoints !== undefined ? { rPoints: order.rPoints } : {}),
    };
    await this.d.store.savePosition(accountId, position);
    this.open.set(position.id, { account: accountId, position });
    return { ok: true, position };
  }

  private async placeNow(accountId: string, raw: unknown, actor: Actor): Promise<Result<PlaceResult>> {
    if (isOptionOrder(raw)) return this.placeOptionNow(accountId, raw, actor);
    const parsed = parseOrderInput(raw);
    if ("error" in parsed) return fail(400, parsed.error);
    const { order } = parsed;
    const account = await this.d.store.getAccount(accountId);
    if (!account) return fail(404, "no such account");
    // idempotency first: a retry must get the original answer, not "already in this contract" or a second fill
    if (order.clientOrderId) {
      const dup = await this.findClientOrder(accountId, order.clientOrderId);
      if (dup) {
        const p = dup.position;
        if (p.symbol !== order.symbol || p.side !== order.side || p.lots !== order.lots) return fail(409, `client_order_id ${order.clientOrderId} was already used for a different order (${p.side} ${p.lots} ${p.symbol})`);
        return { ok: true, position: p, duplicate: true, ...(dup.trade ? { closed: dup.trade } : {}) };
      }
    }
    const lim = this.limits(actor);
    if (order.lots > lim.maxLots) return fail(422, `at most ${lim.maxLots} lot${lim.maxLots === 1 ? "" : "s"} per order for ${actor === "mcp" ? "agents" : "this client"}`);
    const positions = await this.d.store.positions(accountId);
    if (positions.some((p) => p.symbol === order.symbol)) return fail(409, "already in this contract: close that position first");
    if (positions.length >= lim.maxOpenPositions) return fail(422, `at most ${lim.maxOpenPositions} open positions`);
    if ((await this.d.store.ordersSince(accountId, actor, this.d.now() - 86_400_000)) >= lim.maxOrdersPerDay) return fail(422, `order limit reached: at most ${lim.maxOrdersPerDay} orders in 24 hours`);
    const q = this.d.quote(order.symbol);
    if (!q) return fail(503, "no live price for this contract yet");
    if (!this.d.live(order.symbol)) return fail(503, "the market is closed or the feed is stale: paper orders fill only on a live price");
    const units = lotUnits(order.symbol)!;
    const slippage = account.slippage * tickSize(order.symbol);
    const filled = openPaper({ id: this.d.newId(), symbol: order.symbol, side: order.side, lots: order.lots, units, stop: order.stop, target: order.target }, q, slippage, this.d.now());
    if ("error" in filled) return fail(400, filled.error);
    const position: PaperPosition = {
      ...filled,
      actor,
      fill: describeFill(order.side, q, slippage, tickSize(order.symbol)),
      ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
      ...(order.tag ? { tag: order.tag } : {}),
      ...(order.strategy ? { strategy: order.strategy } : {}),
      ...(order.signalTime !== undefined ? { signalTime: order.signalTime } : {}),
      ...(order.rPoints !== undefined ? { rPoints: order.rPoints } : {}),
      ...(order.plan ? { plan: order.plan } : {}),
    };
    await this.d.store.savePosition(accountId, position);
    this.open.set(position.id, { account: accountId, position });
    return { ok: true, position };
  }

  /**
   * A limit order: { symbol or option, side, lots, entry, stop?, target? }. If the market is already at its price it fills at once (at the market price, the
   * limit or better); otherwise it waits, up to 24 hours, and fills when a live quote reaches the price (a buy when the ask is at or under it, a sell when the bid
   * is at or over it), at that price or better and with no slippage: the trader named the price. Stops and targets are checked against the entry price. The
   * same caps as a market order apply, and a waiting order counts as an order and as an open position for them.
   */
  placeLimit(accountId: string, raw: unknown, actor: Actor): Promise<Result<LimitResult>> {
    return this.serial(async () => {
      const r = await this.placeLimitNow(accountId, raw, actor);
      const what = r.ok ? (r.position ? `${r.position.side} ${r.position.lots} ${r.position.option?.label ?? r.position.symbol} @ ${r.position.entry}` : r.pending ? `limit ${r.pending.side} ${r.pending.lots} ${r.pending.option?.label ?? r.pending.symbol} @ ${r.pending.entry}` : "") : "";
      await this.audit(actor, r.ok && r.duplicate ? "place_duplicate" : "place", accountId, raw, r, r.ok ? `${r.duplicate ? "duplicate of " : ""}${what}` : "");
      if (r.ok && !r.duplicate) {
        const who = actor === "mcp" ? "Claude" : "You";
        if (r.position) this.d.publish({ account: accountId, event: "opened", actor, text: `${who} opened ${r.position.lots} lot${r.position.lots === 1 ? "" : "s"} ${r.position.option?.label ?? r.position.symbol} at ${r.position.entry} (limit)` });
        else if (r.pending) this.d.publish({ account: accountId, event: "updated", actor, text: `${who} placed a limit ${r.pending.side} on ${r.pending.option?.label ?? r.pending.symbol} at ${r.pending.entry}` });
      }
      return r;
    });
  }

  private async placeLimitNow(accountId: string, raw: unknown, actor: Actor): Promise<Result<LimitResult>> {
    const isOpt = isOptionOrder(raw);
    const account = await this.d.store.getAccount(accountId);
    if (!account) return fail(404, "no such account");
    // what is being bought or sold: an MCX future, or an option contract (buy only)
    let symbol: string;
    let side: Side;
    let lots: number;
    let units: number;
    let stop: number | undefined;
    let target: number | undefined;
    let entry: number;
    let meta: OrderMeta;
    let option: OptionRef | undefined;
    if (isOpt) {
      const od = this.d.option;
      if (!od) return fail(503, "option paper trading is not available on this server");
      const parsed = parseOptionOrder(raw);
      if ("error" in parsed) return fail(400, parsed.error);
      const o = parsed.order;
      if (o.entry === undefined) return fail(400, "a limit order needs an entry price");
      const info = await od.info(o.key);
      if (!info) return fail(404, "that is not an option contract of ours (crude, crude mini, gas or gas mini)");
      if (this.d.now() >= info.expiresAt) return fail(422, `${info.label} has expired`);
      od.watch?.(o.key);
      symbol = o.key;
      side = "buy";
      lots = o.lots;
      units = info.lot;
      stop = o.stop;
      target = o.target;
      entry = o.entry;
      meta = { clientOrderId: o.clientOrderId, tag: o.tag, strategy: o.strategy, signalTime: o.signalTime, rPoints: o.rPoints };
      option = { key: info.key, label: info.label, underlying: info.underlying, type: info.type, strike: info.strike, expiry: info.expiry, tick: info.tick };
    } else {
      const parsed = parseOrderInput(raw);
      if ("error" in parsed) return fail(400, parsed.error);
      const o = parsed.order;
      if (o.entry === undefined) return fail(400, "a limit order needs an entry price");
      symbol = o.symbol;
      side = o.side;
      lots = o.lots;
      units = lotUnits(o.symbol)!;
      stop = o.stop;
      target = o.target;
      entry = o.entry;
      meta = { clientOrderId: o.clientOrderId, tag: o.tag, strategy: o.strategy, signalTime: o.signalTime, rPoints: o.rPoints };
    }
    const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) as OrderMeta;

    // a retry with the same client_order_id gets the original answer (a waiting order, an open position or a closed trade)
    if (clean.clientOrderId) {
      const waiting = [...this.waiting.values()].find((x) => x.account === accountId && x.order.clientOrderId === clean.clientOrderId);
      if (waiting) {
        if (waiting.order.symbol !== symbol || waiting.order.side !== side || waiting.order.lots !== lots) return fail(409, `client_order_id ${clean.clientOrderId} was already used for a different order`);
        return { ok: true, pending: waiting.order, duplicate: true };
      }
      const dup = await this.findClientOrder(accountId, clean.clientOrderId);
      if (dup) {
        if (dup.position.symbol !== symbol || dup.position.side !== side || dup.position.lots !== lots) return fail(409, `client_order_id ${clean.clientOrderId} was already used for a different order`);
        return { ok: true, position: dup.position, duplicate: true };
      }
    }
    const lim = this.limits(actor);
    if (lots > lim.maxLots) return fail(422, `at most ${lim.maxLots} lot${lim.maxLots === 1 ? "" : "s"} per order for ${actor === "mcp" ? "agents" : "this client"}`);
    const positions = await this.d.store.positions(accountId);
    const waitingHere = [...this.waiting.values()].filter((x) => x.account === accountId);
    if (positions.some((p) => p.symbol === symbol)) return fail(409, "already in this contract: close that position first");
    if (waitingHere.some((x) => x.order.symbol === symbol)) return fail(409, "a limit order for this contract is already waiting: cancel it first");
    if (positions.length + waitingHere.length >= lim.maxOpenPositions) return fail(422, `at most ${lim.maxOpenPositions} open positions and waiting orders`);
    if ((await this.d.store.ordersSince(accountId, actor, this.d.now() - 86_400_000)) >= lim.maxOrdersPerDay) return fail(422, `order limit reached: at most ${lim.maxOrdersPerDay} orders in 24 hours`);

    // a stop must be on the losing side of the entry price and a target on the winning side
    const long = side === "buy";
    if (stop !== undefined && (long ? stop >= entry : stop <= entry)) return fail(400, `A ${long ? "long" : "short"}'s stop must be ${long ? "below" : "above"} the entry price (${entry}).`);
    if (target !== undefined && (long ? target <= entry : target >= entry)) return fail(400, `A ${long ? "long" : "short"}'s target must be ${long ? "above" : "below"} the entry price (${entry}).`);

    const ref = { symbol, option };
    // "filled": the trader already took this trade at `entry` and wants it in the account, whatever the market says now
    const recorded = (raw as { filled?: unknown })?.filled === true;
    const q = this.quoteOf(ref) ?? (recorded ? { price: entry } : undefined);
    const price = recorded ? entry : q && this.liveOf(ref) ? limitFill(side, q, entry) : undefined;
    if (q && price !== undefined) {
      const position = this.positionFrom({ id: this.d.newId(), symbol, side, lots, units, entry, stop, target, createdAt: this.d.now(), expiresAt: 0, actor, ...(option ? { option } : {}), ...clean }, q, price);
      await this.d.store.savePosition(accountId, position);
      this.open.set(position.id, { account: accountId, position });
      return { ok: true, position };
    }
    const order: PendingOrder = { id: this.d.newId(), symbol, side, lots, units, entry, stop, target, createdAt: this.d.now(), expiresAt: this.d.now() + PENDING_TTL_MS, actor, ...(option ? { option } : {}), ...clean };
    await this.d.store.savePending(accountId, order);
    this.waiting.set(order.id, { account: accountId, order });
    return { ok: true, pending: order };
  }

  /** The position a limit order becomes when the market reaches its price. */
  private positionFrom(o: PendingOrder, q: PaperQuote, price: number): PaperPosition {
    const tick = this.tickOf(o);
    return {
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      lots: o.lots,
      units: o.units,
      entry: price,
      ...(o.stop !== undefined ? { stop: o.stop } : {}),
      ...(o.target !== undefined ? { target: o.target } : {}),
      openedAt: this.d.now(),
      actor: o.actor,
      fill: { ...describeLimitFill(o.side, q, price, o.entry), slippageTicks: 0, quote: describeFill(o.side, q, 0, tick).quote },
      ...(o.option ? { option: o.option } : {}),
      ...(o.clientOrderId ? { clientOrderId: o.clientOrderId } : {}),
      ...(o.tag ? { tag: o.tag } : {}),
      ...(o.strategy ? { strategy: o.strategy } : {}),
      ...(o.signalTime !== undefined ? { signalTime: o.signalTime } : {}),
      ...(o.rPoints !== undefined ? { rPoints: o.rPoints } : {}),
    };
  }

  /** Cancel a waiting limit order. */
  cancelOrder(accountId: string, orderId: string, actor: Actor | "engine", why = ""): Promise<Result<{ order: PendingOrder }>> {
    return this.serial(async () => {
      const w = this.waiting.get(orderId);
      const order = w && w.account === accountId ? w.order : (await this.d.store.pendingOrders(accountId)).find((o) => o.id === orderId);
      if (!order) return fail(404, "no such waiting order");
      await this.d.store.deletePending(accountId, orderId);
      this.waiting.delete(orderId);
      await this.audit(actor, "cancel_order", accountId, { orderId, why }, { ok: true }, why);
      this.d.publish({ account: accountId, event: "updated", actor, text: `${why ? `Limit order cancelled: ${why}` : `${actor === "mcp" ? "Claude" : "You"} cancelled a limit order`} (${order.option?.label ?? order.symbol} at ${order.entry})` });
      return { ok: true, order };
    });
  }

  /** A waiting order whose price a live quote has reached becomes a position; one that no longer can (the contract is taken, a cap) or has waited too long is cancelled with the reason. */
  private fillWaiting(accountId: string, orderId: string): Promise<void> {
    return this.serial(async () => {
      const w = this.waiting.get(orderId);
      if (!w || w.account !== accountId) return;
      const o = w.order;
      const cancel = async (why: string) => {
        await this.d.store.deletePending(accountId, orderId);
        this.waiting.delete(orderId);
        await this.audit("engine", "cancel_order", accountId, { orderId, why }, { ok: true }, why);
        this.d.publish({ account: accountId, event: "updated", actor: "engine", text: `Limit order cancelled: ${why} (${o.option?.label ?? o.symbol} at ${o.entry})` });
      };
      if (this.d.now() >= o.expiresAt) return cancel("not filled in 24 hours");
      if (o.option && this.d.now() >= (await this.d.option?.info(o.symbol))!.expiresAt) return cancel("the option expired");
      const q = this.quoteOf(o);
      if (!q || !this.liveOf(o)) return;
      const price = limitFill(o.side, q, o.entry);
      if (price === undefined) return;
      const positions = await this.d.store.positions(accountId);
      if (positions.some((p) => p.symbol === o.symbol)) return cancel("already in this contract");
      const lim = this.limits((o.actor as Actor) ?? "ui");
      if (positions.length >= lim.maxOpenPositions) return cancel(`at most ${lim.maxOpenPositions} open positions`);
      const position = this.positionFrom(o, q, price);
      await this.d.store.savePosition(accountId, position);
      await this.d.store.deletePending(accountId, orderId);
      this.open.set(position.id, { account: accountId, position });
      this.waiting.delete(orderId);
      await this.audit("engine", "fill_limit", accountId, { orderId }, { ok: true }, `${o.side} ${o.lots} ${o.option?.label ?? o.symbol} @ ${price} (limit ${o.entry})`);
      this.d.publish({ account: accountId, event: "opened", actor: "engine", text: `Limit filled: ${o.lots} lot${o.lots === 1 ? "" : "s"} ${o.option?.label ?? o.symbol} ${o.option ? "bought" : o.side === "buy" ? "long" : "short"} at ${price} (limit ${o.entry})` });
    });
  }

  close(accountId: string, positionId: string, actor: Actor | "engine", reason: ExitReason = "manual"): Promise<Result<{ trade: PaperTrade }>> {
    return this.serial(async () => {
      const r = await this.closeNow(accountId, positionId, actor, reason);
      if (actor !== "engine") await this.audit(actor, "close", accountId, { positionId }, r, r.ok ? `net ${r.trade.net.toFixed(0)}` : "");
      if (r.ok) this.d.publish({ account: accountId, event: "closed", actor, text: `${actor === "engine" ? (reason === "expired" ? "Expired, settled: " : reason === "time" ? "Time exit: " : `${reason === "stop" ? "Stop" : "Target"} hit: `) : actor === "mcp" ? "Claude closed " : "You closed "}${r.trade.option?.label ?? r.trade.symbol} ${r.trade.option ? "" : r.trade.side === "buy" ? "long" : "short"}, net ${r.trade.net >= 0 ? "+" : "-"}₹${Math.abs(Math.round(r.trade.net)).toLocaleString("en-IN")}` });
      return r;
    });
  }

  private async closeNow(accountId: string, positionId: string, actor: Actor | "engine", reason: ExitReason): Promise<Result<{ trade: PaperTrade }>> {
    const account = await this.d.store.getAccount(accountId);
    if (!account) return fail(404, "no such account");
    const pos = (await this.d.store.positions(accountId)).find((p) => p.id === positionId);
    if (!pos) return fail(404, "no such open position");
    const last = this.quoteOf(pos);
    if (!last) return fail(503, "no live price for this contract");
    // an expired option has no book to sell into: it settles at its last known premium, with no slippage
    const q: PaperQuote = reason === "expired" ? { price: last.price } : last;
    const slippage = reason === "expired" ? 0 : account.slippage * this.tickOf(pos);
    const closed = closePaper(pos, q, slippage, this.d.now(), reason, await this.d.rates());
    const dir = pos.side === "buy" ? 1 : -1;
    const trade: PaperTrade = {
      ...closed,
      actor: pos.actor,
      closedBy: actor,
      // the labels the order carried, so the trade can be reconciled with the strategy's own records
      ...(pos.clientOrderId ? { clientOrderId: pos.clientOrderId } : {}),
      ...(pos.tag ? { tag: pos.tag } : {}),
      ...(pos.strategy ? { strategy: pos.strategy } : {}),
      ...(pos.signalTime !== undefined ? { signalTime: pos.signalTime } : {}),
      ...(pos.rPoints !== undefined ? { rPoints: pos.rPoints, rMultiple: Number(((dir * (closed.exit - pos.entry)) / pos.rPoints).toFixed(2)) } : {}),
      ...(pos.fill ? { entryFill: pos.fill } : {}),
      exitFill: describeFill(pos.side === "buy" ? "sell" : "buy", q, slippage, this.tickOf(pos)),
    };
    await this.d.store.saveTrade(accountId, trade);
    await this.d.store.deletePosition(accountId, positionId);
    this.open.delete(positionId);
    return { ok: true, trade };
  }

  setStopTarget(accountId: string, positionId: string, raw: unknown, actor: Actor): Promise<Result<{ position: PaperPosition; previous: { stop?: number; target?: number } }>> {
    return this.serial(async () => {
      const parsed = parseStopTarget(raw);
      let r: Result<{ position: PaperPosition; previous: { stop?: number; target?: number } }>;
      if ("error" in parsed) r = fail(400, parsed.error);
      else {
        const pos = (await this.d.store.positions(accountId)).find((p) => p.id === positionId);
        if (!pos) r = fail(404, "no such open position");
        else {
          const next = { ...pos };
          if ("stop" in parsed) parsed.stop === null ? delete next.stop : (next.stop = parsed.stop);
          if ("target" in parsed) parsed.target === null ? delete next.target : (next.target = parsed.target);
          const long = next.side === "buy";
          // a stop or target is checked against where the market is NOW, not the entry: a trailing stop legitimately sits above a long's entry once it is in profit
          const ref = this.quoteOf(pos)?.price ?? pos.entry;
          const word = long ? "long" : "short";
          if (parsed.onlyTighten && "stop" in parsed && parsed.stop === null) r = fail(400, "only_tighten: a stop cannot be removed");
          else if (parsed.onlyTighten && "stop" in parsed && pos.stop !== undefined && next.stop !== undefined && (long ? next.stop < pos.stop : next.stop > pos.stop)) r = fail(400, `only_tighten: a ${word}'s stop can only move ${long ? "up" : "down"} (it is at ${pos.stop}, you asked for ${next.stop})`);
          else if ("stop" in parsed && next.stop !== undefined && (long ? next.stop >= ref : next.stop <= ref)) r = fail(400, `a ${word}'s stop must be ${long ? "below" : "above"} the current price (${ref}): it would trigger at once`);
          else if ("target" in parsed && next.target !== undefined && (long ? next.target <= ref : next.target >= ref)) r = fail(400, `a ${word}'s target must be ${long ? "above" : "below"} the current price (${ref}): it would trigger at once`);
          else {
            await this.d.store.savePosition(accountId, next);
            this.open.set(next.id, { account: accountId, position: next });
            r = { ok: true, position: next, previous: { ...(pos.stop !== undefined ? { stop: pos.stop } : {}), ...(pos.target !== undefined ? { target: pos.target } : {}) } };
          }
        }
      }
      await this.audit(actor, "set_stop_target", accountId, { positionId, ...(raw as object) }, r);
      if (r.ok) this.d.publish({ account: accountId, event: "updated", actor, text: `${actor === "mcp" ? "Claude" : "You"} changed the stop/target on ${r.position.symbol}` });
      return r;
    });
  }

  /**
   * Put an OPTION trade the trader already took and closed by hand into the journal (the Report day and USIB screens): { option: { key }, lots, entry, exit,
   * openedAt, closedAt, reason?, strategy?, tag?, note?, client_order_id? }. Nothing is filled or priced: the entry and exit are the trader's own premiums, with no
   * slippage, charged with the option rates. A repeat of a client_order_id returns the trade already stored. Browser only.
   */
  recordClosed(accountId: string, raw: any, actor: Actor): Promise<Result<{ trade: PaperTrade; duplicate?: true }>> {
    return this.serial(async () => {
      const r = await this.recordClosedNow(accountId, raw, actor);
      await this.audit(actor, "record_closed", accountId, raw, r, r.ok ? `${r.trade.option?.label ?? r.trade.symbol} net ${r.trade.net.toFixed(0)}${r.duplicate ? " (duplicate)" : ""}` : "");
      if (r.ok && !r.duplicate) this.d.publish({ account: accountId, event: "closed", actor, text: `Recorded a closed trade: ${r.trade.option?.label ?? r.trade.symbol}, net ${r.trade.net >= 0 ? "+" : "-"}₹${Math.abs(Math.round(r.trade.net)).toLocaleString("en-IN")}` });
      return r;
    });
  }

  private async recordClosedNow(accountId: string, raw: any, actor: Actor): Promise<Result<{ trade: PaperTrade; duplicate?: true }>> {
    if (actor !== "ui") return fail(422, "closed trades are recorded from the browser");
    const od = this.d.option;
    if (!od) return fail(503, "option paper trading is not available on this server");
    if (!(await this.d.store.getAccount(accountId))) return fail(404, "no such account");
    const key = raw?.option?.key;
    if (typeof key !== "string" || !PAPER_OPTION_KEY.test(key)) return fail(400, "option.key must be an Upstox option key such as MCX_FO|583810");
    const pos = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
    if (!Number.isInteger(raw.lots) || raw.lots < 1 || raw.lots > 1000) return fail(400, "lots must be a whole number of 1 or more");
    if (!pos(raw.entry) || !pos(raw.exit)) return fail(400, "entry and exit must be positive premiums");
    if (!pos(raw.openedAt) || !pos(raw.closedAt) || raw.closedAt < raw.openedAt || raw.closedAt > this.d.now() + 60_000) return fail(400, "openedAt and closedAt must be times (epoch ms), closed after opened and not in the future");
    const meta = parseOrderMeta({ client_order_id: raw.client_order_id, tag: raw.tag, strategy: raw.strategy });
    if ("error" in meta) return fail(400, meta.error);
    const cid = meta.meta.clientOrderId;
    if (cid) {
      const dup = (await this.d.store.trades(accountId, MAX_TRADES_KEPT)).find((x) => x.clientOrderId === cid);
      if (dup) return { ok: true, trade: dup, duplicate: true };
    }
    const info = await od.info(key);
    if (!info) return fail(404, "that is not an option contract of ours (crude, crude mini, gas or gas mini)");
    const ref: OptionRef = { key: info.key, label: info.label, underlying: info.underlying, type: info.type, strike: info.strike, expiry: info.expiry, tick: info.tick };
    const position: PaperPosition = { id: this.d.newId(), symbol: key, side: "buy", lots: raw.lots, units: info.lot, entry: raw.entry, openedAt: raw.openedAt, actor, option: ref };
    const closed = closePaper(position, { price: raw.exit }, 0, raw.closedAt, raw.reason === "stop" || raw.reason === "target" ? raw.reason : "manual", await this.d.rates(), typeof raw.note === "string" ? raw.note.slice(0, MAX_NOTE) : "");
    const trade: PaperTrade = { ...closed, actor, closedBy: actor, ...meta.meta };
    await this.d.store.saveTrade(accountId, trade);
    return { ok: true, trade };
  }

  /** One-time import of the account the browser kept before accounts moved to the server: only into an empty account, only well-formed rows. */
  importLegacy(accountId: string, data: any, actor: Actor): Promise<Result<{ positions: number; trades: number }>> {
    return this.serial(async () => {
      const account = await this.d.store.getAccount(accountId);
      if (!account) return fail(404, "no such account");
      if ((await this.d.store.positions(accountId)).length || (await this.d.store.trades(accountId, 1)).length) return fail(409, "the server account already has trades: nothing imported");
      const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
      const sideOk = (v: unknown) => v === "buy" || v === "sell";
      const mcx = (s: unknown) => typeof s === "string" && lotUnits(s) !== undefined && instrument(s)?.exchange === "MCX";
      const positions: PaperPosition[] = (Array.isArray(data?.positions) ? data.positions : [])
        .filter((p: any) => typeof p?.id === "string" && mcx(p.symbol) && sideOk(p.side) && Number.isInteger(p.lots) && p.lots >= 1 && num(p.units) && num(p.entry) && num(p.openedAt))
        .slice(0, 20)
        .map((p: any) => ({ id: `legacy-${p.id}`.slice(0, 60), symbol: p.symbol, side: p.side, lots: p.lots, units: p.units, entry: p.entry, openedAt: p.openedAt, ...(num(p.stop) ? { stop: p.stop } : {}), ...(num(p.target) ? { target: p.target } : {}), actor: "ui" }));
      const trades: PaperTrade[] = (Array.isArray(data?.trades) ? data.trades : [])
        .filter((t: any) => typeof t?.id === "string" && mcx(t.symbol) && sideOk(t.side) && Number.isInteger(t.lots) && ["entry", "exit", "units", "openedAt", "closedAt", "gross", "costs", "net"].every((k) => num(t[k])) && ["manual", "stop", "target"].includes(t.reason))
        .slice(0, MAX_TRADES_KEPT)
        .map((t: any) => ({ id: `legacy-${t.id}`.slice(0, 60), symbol: t.symbol, side: t.side, lots: t.lots, units: t.units, entry: t.entry, exit: t.exit, openedAt: t.openedAt, closedAt: t.closedAt, gross: t.gross, costs: t.costs, net: t.net, reason: t.reason, note: typeof t.note === "string" ? t.note.slice(0, MAX_NOTE) : "", actor: "ui", closedBy: "ui" }));
      for (const p of positions) await this.d.store.savePosition(accountId, p);
      for (const t of [...trades].reverse()) await this.d.store.saveTrade(accountId, t); // stored oldest first
      if (num(data?.capital) && data.capital > 0) await this.d.store.saveAccount({ ...account, capital: data.capital, ...(num(data?.slippage) && data.slippage >= 0 ? { slippage: data.slippage } : {}) });
      await this.refresh();
      await this.audit(actor, "import", accountId, { positions: positions.length, trades: trades.length }, { ok: true });
      this.d.publish({ account: accountId, event: "imported", actor, text: `Imported ${trades.length} trades and ${positions.length} open positions from this browser` });
      return { ok: true, positions: positions.length, trades: trades.length };
    });
  }

  async setNote(accountId: string, tradeId: string, note: unknown, actor: Actor): Promise<Result<object>> {
    if (typeof note !== "string") return fail(400, "note must be text");
    const ok = await this.d.store.setNote(accountId, tradeId, note.slice(0, MAX_NOTE));
    if (!ok) return fail(404, "no such trade");
    await this.audit(actor, "note", accountId, { tradeId }, { ok: true });
    this.d.publish({ account: accountId, event: "updated", actor, text: "Journal note saved" });
    return { ok: true };
  }

  reset(accountId: string, actor: Actor): Promise<Result<object>> {
    return this.serial(async () => {
      if (!(await this.d.store.getAccount(accountId))) return fail(404, "no such account");
      await this.d.store.reset(accountId);
      for (const [id, x] of this.open) if (x.account === accountId) this.open.delete(id);
      for (const [id, x] of this.waiting) if (x.account === accountId) this.waiting.delete(id);
      await this.audit(actor, "reset", accountId, {}, { ok: true });
      this.d.publish({ account: accountId, event: "reset", actor, text: "Account reset" });
      return { ok: true };
    });
  }

  /** Is the position's plan due: past its close time, or TP1 reached and the stop not yet at the entry? */
  private planDue(p: PaperPosition): boolean {
    if (!p.plan) return false;
    if (this.d.now() >= p.plan.closeAt) return true;
    const price = this.quoteOf(p)?.price;
    return !p.plan.tp1Done && price !== undefined && (p.side === "buy" ? price >= p.plan.tp1 : price <= p.plan.tp1);
  }

  /** Carry out a due plan: the time exit closes at the market; TP1 moves the stop to the entry unless it is already tighter. */
  private runPlan(accountId: string, positionId: string): Promise<void> {
    return this.serial(async () => {
      const pos = (await this.d.store.positions(accountId)).find((p) => p.id === positionId);
      if (!pos?.plan || !this.planDue(pos)) return;
      if (this.d.now() >= pos.plan.closeAt) {
        const r = await this.closeNow(accountId, positionId, "engine", "time");
        if (r.ok) this.d.publish({ account: accountId, event: "closed", actor: "engine", text: `Time exit: ${r.trade.symbol} ${r.trade.side === "buy" ? "long" : "short"}, net ${r.trade.net >= 0 ? "+" : "-"}₹${Math.abs(Math.round(r.trade.net)).toLocaleString("en-IN")}` });
        await this.audit("engine", "plan_time_exit", accountId, { positionId }, r, r.ok ? `net ${r.trade.net.toFixed(0)}` : "");
        return;
      }
      const long = pos.side === "buy";
      const next: PaperPosition = { ...pos, plan: { ...pos.plan, tp1Done: true }, ...(pos.stop === undefined || (long ? pos.stop < pos.entry : pos.stop > pos.entry) ? { stop: pos.entry } : {}) };
      await this.d.store.savePosition(accountId, next);
      this.open.set(next.id, { account: accountId, position: next });
      await this.audit("engine", "plan_tp1", accountId, { positionId }, { ok: true }, `stop to ${next.stop}`);
      this.d.publish({ account: accountId, event: "updated", actor: "engine", text: `TP1 reached on ${pos.symbol}: stop moved to the entry ${next.stop}` });
    });
  }

  /** Close positions whose stop or target a LIVE price has reached. Call after every accepted quote; cheap (no query unless something fires). */
  onQuotes(): Promise<void> {
    const fills = [...this.waiting.values()].filter(({ order }) => {
      if (this.d.now() >= order.expiresAt) return true;
      const q = this.quoteOf(order);
      return q && this.liveOf(order) && limitFill(order.side, q, order.entry) !== undefined;
    });
    const filling = fills.length ? Promise.all(fills.map(({ account, order }) => this.fillWaiting(account, order.id))).then(() => undefined) : Promise.resolve();
    const lapsed = [...this.open.values()].filter(({ position }) => this.expired(position) && this.quoteOf(position));
    const due = [...this.open.values()].filter(({ position }) => {
      const q = this.quoteOf(position);
      return !this.expired(position) && q && this.liveOf(position) && exitHit(position, q.price);
    });
    const planned = [...this.open.values()].filter(({ position }) => position.plan && !position.option && this.quoteOf(position) && this.liveOf(position) && this.planDue(position));
    if (due.length === 0 && lapsed.length === 0 && planned.length === 0) return filling;
    return Promise.all([
      filling,
      ...planned.map(({ account, position }) => this.runPlan(account, position.id)),
      ...lapsed.map(({ account, position }) => this.close(account, position.id, "engine", "expired").then(() => undefined)),
      ...due.map(({ account, position }) => {
        const q = this.quoteOf(position)!;
        const hit = exitHit(position, q.price);
        return hit ? this.close(account, position.id, "engine", hit).then(() => undefined) : undefined;
      }),
    ]).then(() => undefined);
  }
}

export { UPSTOX_MCX_RATES };
