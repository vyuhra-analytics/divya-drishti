// The option contracts clients want live over the Upstox feed, and for how long. The stream keeps one feed connection, subscribed to our six
// futures; a client that shows an option chain names the contracts it needs (a `watch` message) and repeats it every ~20 s. A contract nobody
// has asked for in `ttl` is dropped, so a closed tab or a changed expiry stops costing a subscription. Bounded: at most `max` contracts in all.
import { OPTION_KEY } from "@drishti/shared";

export const WATCH_MAX = 40;
export const WATCH_PER_REQUEST = 24;
export const WATCH_TTL_MS = 60_000;

export interface WatchResult {
  /** keys now watched because of this request (new or extended) */
  accepted: number;
  /** keys left out: not an Upstox MCX derivative key, not a contract we know, over the per-request cap, or over the total cap */
  refused: number;
}

export class OptionWatch {
  private until = new Map<string, number>();
  private listeners: (() => void)[] = [];

  constructor(
    /** is this a contract we know (from the instrument master)? */
    private known: (key: string) => boolean,
    private now: () => number = Date.now,
    private max = WATCH_MAX,
    private ttl = WATCH_TTL_MS,
  ) {}

  /** Call `fn` whenever the set of watched keys changes (added or expired). */
  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  /** Watched keys right now, expired ones removed first. */
  wanted(): string[] {
    this.sweep();
    return [...this.until.keys()];
  }

  /** A client's request. Anything that is not a list of strings is ignored; each key is checked before it costs a subscription. */
  request(keys: unknown): WatchResult {
    const result: WatchResult = { accepted: 0, refused: 0 };
    if (!Array.isArray(keys)) return result;
    this.sweep();
    let added = false;
    keys.forEach((k, i) => {
      if (i >= WATCH_PER_REQUEST || typeof k !== "string" || !OPTION_KEY.test(k) || !this.known(k)) return void result.refused++;
      if (!this.until.has(k) && this.until.size >= this.max) return void result.refused++;
      if (!this.until.has(k)) added = true;
      this.until.set(k, this.now() + this.ttl);
      result.accepted++;
    });
    if (added) this.notify();
    return result;
  }

  /** Drop keys nobody has asked for lately; tell listeners if any went. */
  sweep() {
    const t = this.now();
    let dropped = false;
    for (const [k, until] of this.until) {
      if (until <= t) {
        this.until.delete(k);
        dropped = true;
      }
    }
    if (dropped) this.notify();
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }
}

/** What to send on the open feed socket to move from the subscribed keys to the wanted ones. */
export function subscriptionDiff(subscribed: ReadonlySet<string>, wanted: readonly string[]): { sub: string[]; unsub: string[] } {
  const want = new Set(wanted);
  return { sub: wanted.filter((k) => !subscribed.has(k)), unsub: [...subscribed].filter((k) => !want.has(k)) };
}

/** Lag statistics over the last `cap` option ticks (exchange trade time to our receipt), for /health and the acceptance check. */
export class LagWindow {
  private lags: number[] = [];
  constructor(private cap = 300) {}
  add(ms: number | undefined) {
    if (ms === undefined) return;
    this.lags.push(ms);
    if (this.lags.length > this.cap) this.lags.shift();
  }
  get count() {
    return this.lags.length;
  }
  /** nearest-rank percentile over the window, undefined when empty */
  pct(p: number): number | undefined {
    if (!this.lags.length) return undefined;
    const s = [...this.lags].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  }
}
