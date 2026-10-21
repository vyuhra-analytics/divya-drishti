// Alert rules, evaluated in the browser while the terminal is open. Pure: `check` takes the world and returns
// the (possibly updated) alert plus a message when it fires.
import type { CalEvent } from "./calendar";
import { matchesQuery, type NewsItem } from "./news";

export type AlertKind = "price" | "change" | "news" | "release";
export type AlertOp = "above" | "below";

export interface Alert {
  id: string;
  kind: AlertKind;
  /** price / change: instrument symbol */
  symbol?: string;
  op?: AlertOp;
  /** price level, or % move vs previous close */
  value?: number;
  /** news: headline/outlet text; release: part of the release title */
  text?: string;
  /** release: minutes of lead time */
  minutes?: number;
  /** price / change fire once, then wait to be re-armed; news / release keep watching */
  armed: boolean;
  /** price / change: the value seen last time, so a cross is detected between two observations */
  last?: number;
  /** release: the event already announced */
  lastEvent?: string;
  firedAt?: number;
  /** server alerts: when the user last re-armed it (a re-arm made after the last fire wins over the engine's own copy) */
  rearmedAt?: number;
}

/** Went from one side of `level` to the other (or touched it) between two observations. */
export const crossed = (op: AlertOp, level: number, prev: number, now: number) =>
  op === "above" ? prev < level && now >= level : prev > level && now <= level;

export function describe(a: Alert): string {
  switch (a.kind) {
    case "price":
      return `${a.symbol} ${a.op} ${a.value}`;
    case "change":
      return `${a.symbol} ${a.op === "above" ? "up" : "down"} ${Math.abs(a.value ?? 0)}% or more on the day`;
    case "news":
      return `Headline mentions "${a.text}"`;
    case "release":
      return `${a.minutes} min before "${a.text}"`;
  }
}

export interface AlertWorld {
  quotes: Record<string, { price: number; prevClose?: number } | undefined>;
  /** headlines that arrived since the last check */
  freshNews: NewsItem[];
  events: CalEvent[];
  now: number;
}

/** Evaluate one alert. `message` is set when it fires; `next` carries the updated bookkeeping. */
export function check(a: Alert, w: AlertWorld): { next: Alert; message?: string } {
  if (a.kind === "price" || a.kind === "change") {
    const q = a.symbol ? w.quotes[a.symbol] : undefined;
    const cur = a.kind === "price" ? q?.price : q?.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : undefined;
    if (cur === undefined || a.value === undefined || !a.op) return { next: a };
    const next = { ...a, last: cur };
    if (!a.armed || a.last === undefined || !crossed(a.op, a.value, a.last, cur)) return { next };
    const shown = a.kind === "price" ? String(q!.price) : `${cur.toFixed(2)}%`;
    return { next: { ...next, armed: false, firedAt: w.now }, message: `${a.symbol}: ${shown} (${a.op} ${a.value}${a.kind === "change" ? "%" : ""})` };
  }
  if (a.kind === "news") {
    if (!a.text) return { next: a };
    const hit = w.freshNews.find((n) => matchesQuery(n, a.text!));
    return hit ? { next: { ...a, firedAt: w.now }, message: `${hit.source}: ${hit.title}` } : { next: a };
  }
  // release
  if (!a.text || a.minutes === undefined) return { next: a };
  const needle = a.text.toLowerCase();
  const ev = w.events.find((e) => e.id !== a.lastEvent && e.at > w.now && e.at - w.now <= a.minutes! * 60_000 && e.title.toLowerCase().includes(needle));
  if (!ev) return { next: a };
  const mins = Math.max(1, Math.round((ev.at - w.now) / 60_000));
  return { next: { ...a, lastEvent: ev.id, firedAt: w.now }, message: `${ev.title} in ${mins} min` };
}
