// Server-side alerts: the same rules as the browser's (alerts.ts `check`), kept in the database and evaluated by the stream service,
// so they fire when the app is closed and reach Telegram or a webhook. The engine is plain logic over injected dependencies: tested
// with fakes, wired to Postgres, the live quotes and the notifier in the stream.
import { check, describe, type Alert, type AlertKind, type AlertOp, type AlertWorld } from "./alerts";
import type { CalEvent } from "./calendar";
import { SYMBOLS } from "./index";
import type { NewsItem } from "./news";
import type { AlertNotice } from "./notify";

export const MAX_SERVER_ALERTS = 50;

/** Validate an alert from a request body. Anything unexpected is refused with a reason, never coerced. */
export function parseAlertInput(body: any): { alert: Omit<Alert, "id" | "armed"> } | { error: string } {
  const kind = body?.kind as AlertKind;
  if (!["price", "change", "news", "release"].includes(kind)) return { error: "kind must be price, change, news or release" };
  if (kind === "price" || kind === "change") {
    if (!SYMBOLS.includes(body.symbol)) return { error: `symbol must be one of ${SYMBOLS.join(", ")}` };
    if (body.op !== "above" && body.op !== "below") return { error: "op must be above or below" };
    const value = Number(body.value);
    if (!Number.isFinite(value) || value === 0 || (kind === "price" ? value < 0 : Math.abs(value) > 100)) return { error: kind === "price" ? "value must be a positive price" : "value must be a percent between -100 and 100" };
    return { alert: { kind, symbol: body.symbol, op: body.op as AlertOp, value } };
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 2 || text.length > 100) return { error: "text must be 2 to 100 characters" };
  if (kind === "news") return { alert: { kind, text } };
  const minutes = Number(body.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return { error: "minutes must be a whole number from 1 to 1440" };
  return { alert: { kind, text, minutes } };
}

export interface ServerAlertDeps {
  /** the rules as stored */
  load(): Promise<Alert[]>;
  /** persist a rule's bookkeeping after it fired (armed, firedAt, lastEvent) */
  save(a: Alert): Promise<void>;
  /** deliver and publish a fired alert; must not throw (failures are the notifier's to report) */
  notify(n: AlertNotice): Promise<void>;
  events(): Promise<CalEvent[]>;
  now(): number;
}

export class ServerAlertEngine {
  private alerts = new Map<string, Alert>();
  // the value seen last time per alert lives here, not in the database: it changes every tick
  private lasts = new Map<string, number | undefined>();

  constructor(private readonly d: ServerAlertDeps) {}

  get size() {
    return this.alerts.size;
  }

  /** Reload the rules from the database. A rule that fired here a moment ago keeps its fired state, so a reload that races the save cannot re-arm it; a deliberate re-arm still takes effect. */
  async refresh() {
    const rows = await this.d.load();
    const next = new Map<string, Alert>();
    for (const row of rows) {
      const mine = this.alerts.get(row.id);
      // the database copy is armed but older than our own fire (the save has not landed): ours stands. A re-arm made after the fire wins.
      const stale = mine && !mine.armed && row.armed && (row.rearmedAt ?? 0) <= (mine.firedAt ?? 0);
      next.set(row.id, stale ? mine : row);
    }
    for (const id of this.lasts.keys()) if (!next.has(id)) this.lasts.delete(id);
    this.alerts = next;
  }

  /** Price and day-change alerts, on every quote update. */
  onQuotes(quotes: AlertWorld["quotes"]) {
    return this.run({ quotes, freshNews: [], events: [], now: this.d.now() }, ["price", "change"]);
  }

  /** Headline alerts, on headlines that have just arrived. */
  onNews(freshNews: NewsItem[]) {
    return freshNews.length ? this.run({ quotes: {}, freshNews, events: [], now: this.d.now() }, ["news"]) : Promise.resolve();
  }

  /** Release alerts, on a timer. */
  async tick() {
    if (![...this.alerts.values()].some((a) => a.kind === "release")) return;
    await this.run({ quotes: {}, freshNews: [], events: await this.d.events(), now: this.d.now() }, ["release"]);
  }

  // evaluations run one at a time: a burst of quotes during a slow database save must not evaluate the same alert twice
  private queue: Promise<unknown> = Promise.resolve();
  private run(world: AlertWorld, kinds: AlertKind[]): Promise<void> {
    const p = this.queue.then(() => this.runNow(world, kinds));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async runNow(world: AlertWorld, kinds: AlertKind[]) {
    for (const a of [...this.alerts.values()]) {
      if (!kinds.includes(a.kind)) continue;
      const { next, message } = check({ ...a, last: this.lasts.get(a.id) }, world);
      this.lasts.set(a.id, next.last);
      const { last: _last, ...saved } = next;
      const changed = saved.armed !== a.armed || saved.firedAt !== a.firedAt || saved.lastEvent !== a.lastEvent;
      if (changed) {
        this.alerts.set(a.id, { ...saved, last: undefined });
        await this.d.save({ ...saved, last: undefined }); // saved BEFORE delivery: a crash in between loses one message, never repeats it
      }
      if (message) await this.d.notify({ id: a.id, rule: describe(a), message, at: world.now });
    }
  }
}
