// Server-side paper trading: accounts, positions and the trade journal kept in Postgres and driven by the stream service, so a paper trade
// can be placed from the browser OR by an agent over MCP and both see the same account. The engine is plain logic over injected
// dependencies (store, quotes, clock, publisher), tested with fakes; the stream wires it to Postgres and the live quotes.
// Nothing in here can reach a broker: orders are simulated fills on live quotes, like paper.ts.
import { UPSTOX_MCX_RATES, type CostRates, type Side } from "./costs";
import { lotUnits } from "./costs";
import { instrument } from "./index";
import { closePaper, exitHit, openPaper, summarizeAccount, unrealisedNet, type Account, type ExitReason, type PaperPosition, type PaperQuote, type PaperTrade } from "./paper";

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

export interface OrderInput {
  symbol: string;
  side: Side;
  lots: number;
  stop?: number;
  target?: number;
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
  try {
    return { order: { symbol, side: body.side, lots, stop: num(body.stop, "stop"), target: num(body.target, "target") } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A stop/target change: a number sets it, null clears it, absent leaves it alone. */
export function parseStopTarget(body: any): { stop?: number | null; target?: number | null } | { error: string } {
  const out: { stop?: number | null; target?: number | null } = {};
  for (const k of ["stop", "target"] as const) {
    if (!(k in (body ?? {}))) continue;
    const v = body[k];
    if (v === null) out[k] = null;
    else if (Number.isFinite(Number(v)) && Number(v) > 0 && v !== "" && v !== true) out[k] = Number(v);
    else return { error: `${k} must be a positive price, or null to remove it` };
  }
  if (!("stop" in out) && !("target" in out)) return { error: "give a stop and/or a target (null removes one)" };
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

  place(accountId: string, raw: unknown, actor: Actor): Promise<Result<{ position: PaperPosition }>> {
    return this.serial(async () => {
      const r = await this.placeNow(accountId, raw, actor);
      await this.audit(actor, "place", accountId, raw, r, r.ok ? `${r.position.side} ${r.position.lots} ${r.position.symbol} @ ${r.position.entry}` : "");
      if (r.ok) this.d.publish({ account: accountId, event: "opened", actor, text: `${actor === "mcp" ? "Claude" : "You"} opened ${r.position.lots} lot${r.position.lots === 1 ? "" : "s"} ${r.position.symbol} ${r.position.side === "buy" ? "long" : "short"} at ${r.position.entry}` });
      return r;
    });
  }

  private async placeNow(accountId: string, raw: unknown, actor: Actor): Promise<Result<{ position: PaperPosition }>> {
    const parsed = parseOrderInput(raw);
    if ("error" in parsed) return fail(400, parsed.error);
    const { order } = parsed;
    const account = await this.d.store.getAccount(accountId);
    if (!account) return fail(404, "no such account");
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
    const filled = openPaper({ id: this.d.newId(), symbol: order.symbol, side: order.side, lots: order.lots, units, stop: order.stop, target: order.target }, q, account.slippage * tickSize(order.symbol), this.d.now());
    if ("error" in filled) return fail(400, filled.error);
    const position = { ...filled, actor };
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
    const trade = { ...closePaper(pos, q, account.slippage * tickSize(pos.symbol), this.d.now(), reason, await this.d.rates()), actor: pos.actor, closedBy: actor };
    await this.d.store.saveTrade(accountId, trade);
    await this.d.store.deletePosition(accountId, positionId);
    this.open.delete(positionId);
    return { ok: true, trade };
  }

  setStopTarget(accountId: string, positionId: string, raw: unknown, actor: Actor): Promise<Result<{ position: PaperPosition }>> {
    return this.serial(async () => {
      const parsed = parseStopTarget(raw);
      let r: Result<{ position: PaperPosition }>;
      if ("error" in parsed) r = fail(400, parsed.error);
      else {
        const pos = (await this.d.store.positions(accountId)).find((p) => p.id === positionId);
        if (!pos) r = fail(404, "no such open position");
        else {
          const next = { ...pos };
          if ("stop" in parsed) parsed.stop === null ? delete next.stop : (next.stop = parsed.stop);
          if ("target" in parsed) parsed.target === null ? delete next.target : (next.target = parsed.target);
          const long = next.side === "buy";
          if (next.stop !== undefined && (long ? next.stop >= next.entry : next.stop <= next.entry)) r = fail(400, `a ${long ? "long" : "short"}'s stop must be ${long ? "below" : "above"} the entry (${next.entry})`);
          else if (next.target !== undefined && (long ? next.target <= next.entry : next.target >= next.entry)) r = fail(400, `a ${long ? "long" : "short"}'s target must be ${long ? "above" : "below"} the entry (${next.entry})`);
          else {
            await this.d.store.savePosition(accountId, next);
            this.open.set(next.id, { account: accountId, position: next });
            r = { ok: true, position: next };
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
