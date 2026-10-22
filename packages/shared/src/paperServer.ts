// Server-side paper trading: accounts, positions and the trade journal kept in Postgres and driven by the stream service, so a paper trade
// can be placed from the browser OR by an agent over MCP and both see the same account. The engine is plain logic over injected
// dependencies (store, quotes, clock, publisher), tested with fakes; the stream wires it to Postgres and the live quotes.
// Nothing in here can reach a broker: orders are simulated fills on live quotes, like paper.ts.
import { UPSTOX_MCX_RATES, type CostRates, type Side } from "./costs";
import { lotUnits } from "./costs";
import { instrument } from "./index";
import { closePaper, describeFill, exitHit, openPaper, summarizeAccount, unrealisedNet, type Account, type ExitReason, type OrderMeta, type PaperPosition, type PaperQuote, type PaperTrade } from "./paper";

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
  try {
    return { order: { symbol, side: body.side, lots, stop: num(body.stop, "stop"), target: num(body.target, "target"), ...m.meta } };
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
  /** orders placed by `actor` on `account` since `sinceMs` (from the audit log) */
  ordersSince(account: string, actor: string, sinceMs: number): Promise<number>;
  audit(e: AuditEntry): Promise<void>;
}

export interface PaperDeps {
  store: PaperStore;
  quote(symbol: string): PaperQuote | undefined;
  /** the exchange is open and the feed was heard from in the last minute */
  live(symbol: string): boolean;
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

export type Result<T> = ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409 | 422 | 503; error: string };
const fail = (status: 400 | 404 | 409 | 422 | 503, error: string) => ({ ok: false as const, status, error });

export interface AccountState {
  account: AccountRow;
  positions: PaperPosition[];
  trades: PaperTrade[];
  rates: CostRates;
  limits: Limits;
  summary: Account;
}

export class PaperEngine {
  private open = new Map<string, { account: string; position: PaperPosition }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: PaperDeps) {}

  private limits(actor: Actor): Limits {
    return (this.d.limits ?? DEFAULT_LIMITS)[actor];
  }

  /** Run one change at a time: two orders or a stop firing during an order must not see half-written state. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Reload open positions from the database (they are cached so a stop check on every tick costs no query). */
  async refresh() {
    const all = await this.d.store.allPositions();
    this.open = new Map(all.map((x) => [x.position.id, x]));
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
    const [positions, trades, rates] = await Promise.all([this.d.store.positions(id), this.d.store.trades(id, 100), this.d.rates()]);
    const nets = positions.map((p) => {
      const q = this.d.quote(p.symbol);
      return q ? unrealisedNet(p, q, account.slippage * tickSize(p.symbol), rates) : 0;
    });
    const all = await this.d.store.trades(id, MAX_TRADES_KEPT);
    return { ok: true, state: { account, positions, trades, rates, limits: this.limits(actor), summary: summarizeAccount(account.capital, [...all].reverse(), nets) } };
  }

  place(accountId: string, raw: unknown, actor: Actor): Promise<Result<PlaceResult>> {
    return this.serial(async () => {
      const r = await this.placeNow(accountId, raw, actor);
      // a repeat of an order already filled is recorded under its own action, so it never counts toward the daily order cap
      await this.audit(actor, r.ok && r.duplicate ? "place_duplicate" : "place", accountId, raw, r, r.ok ? `${r.duplicate ? "duplicate of " : ""}${r.position.side} ${r.position.lots} ${r.position.symbol} @ ${r.position.entry}` : "");
      if (r.ok && !r.duplicate) this.d.publish({ account: accountId, event: "opened", actor, text: `${actor === "mcp" ? "Claude" : "You"} opened ${r.position.lots} lot${r.position.lots === 1 ? "" : "s"} ${r.position.symbol} ${r.position.side === "buy" ? "long" : "short"} at ${r.position.entry}` });
      return r;
    });
  }

  /** An order the caller already placed with this client_order_id: the open position, or (once closed) the position as it was with its trade. */
  private async findClientOrder(accountId: string, clientOrderId: string): Promise<{ position: PaperPosition; trade?: PaperTrade } | undefined> {
    const open = (await this.d.store.positions(accountId)).find((p) => p.clientOrderId === clientOrderId);
    if (open) return { position: open };
    const trade = (await this.d.store.trades(accountId, MAX_TRADES_KEPT)).find((t) => t.clientOrderId === clientOrderId);
    if (!trade) return undefined;
    const { id, symbol, side, lots, units, entry, openedAt, actor, clientOrderId: cid, tag, strategy, signalTime, rPoints, entryFill } = trade;
    return { position: { id, symbol, side, lots, units, entry, openedAt, actor, clientOrderId: cid, tag, strategy, signalTime, rPoints, fill: entryFill }, trade };
  }

  private async placeNow(accountId: string, raw: unknown, actor: Actor): Promise<Result<PlaceResult>> {
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
    };
    await this.d.store.savePosition(accountId, position);
    this.open.set(position.id, { account: accountId, position });
    return { ok: true, position };
  }

  close(accountId: string, positionId: string, actor: Actor | "engine", reason: ExitReason = "manual"): Promise<Result<{ trade: PaperTrade }>> {
    return this.serial(async () => {
      const r = await this.closeNow(accountId, positionId, actor, reason);
      if (actor !== "engine") await this.audit(actor, "close", accountId, { positionId }, r, r.ok ? `net ${r.trade.net.toFixed(0)}` : "");
      if (r.ok) this.d.publish({ account: accountId, event: "closed", actor, text: `${actor === "engine" ? `${reason === "stop" ? "Stop" : "Target"} hit: ` : actor === "mcp" ? "Claude closed " : "You closed "}${r.trade.symbol} ${r.trade.side === "buy" ? "long" : "short"}, net ${r.trade.net >= 0 ? "+" : "-"}₹${Math.abs(Math.round(r.trade.net)).toLocaleString("en-IN")}` });
      return r;
    });
  }

  private async closeNow(accountId: string, positionId: string, actor: Actor | "engine", reason: ExitReason): Promise<Result<{ trade: PaperTrade }>> {
    const account = await this.d.store.getAccount(accountId);
    if (!account) return fail(404, "no such account");
    const pos = (await this.d.store.positions(accountId)).find((p) => p.id === positionId);
    if (!pos) return fail(404, "no such open position");
    const q = this.d.quote(pos.symbol);
    if (!q) return fail(503, "no live price for this contract");
    const slippage = account.slippage * tickSize(pos.symbol);
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
      exitFill: describeFill(pos.side === "buy" ? "sell" : "buy", q, slippage, tickSize(pos.symbol)),
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
          const ref = this.d.quote(pos.symbol)?.price ?? pos.entry;
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
      await this.audit(actor, "reset", accountId, {}, { ok: true });
      this.d.publish({ account: accountId, event: "reset", actor, text: "Account reset" });
      return { ok: true };
    });
  }

  /** Close positions whose stop or target a LIVE price has reached. Call after every accepted quote; cheap (no query unless something fires). */
  onQuotes(): Promise<void> {
    const due = [...this.open.values()].filter(({ position }) => {
      const q = this.d.quote(position.symbol);
      return q && this.d.live(position.symbol) && exitHit(position, q.price);
    });
    if (due.length === 0) return Promise.resolve();
    return Promise.all(
      due.map(({ account, position }) => {
        const q = this.d.quote(position.symbol)!;
        const hit = exitHit(position, q.price);
        return hit ? this.close(account, position.id, "engine", hit).then(() => undefined) : undefined;
      }),
    ).then(() => undefined);
  }
}

export { UPSTOX_MCX_RATES };
