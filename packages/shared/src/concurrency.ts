// One place for "do at most N of these at once" against third-party services (EIA, TradingView), instead of hand-written batches.

/** A gate: `run(fn)` starts fn when fewer than `limit` calls are running, otherwise queues it. Errors reach only their own caller. */
export function limiter(limit: number) {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

/** `items.map(fn)` with at most `limit` running at once; results keep the input order. The first rejection rejects the whole call (queued items still run to completion, so catch per item for best-effort). */
export function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const run = limiter(limit);
  return Promise.all(items.map((item, i) => run(() => fn(item, i))));
}

/**
 * A pacer for a rate-limited service: `wait()` resolves so that successive callers start at least `gapMs` apart (the first at once), however many
 * ask together. Upstox allows 50 requests a second but only 2,000 in 30 minutes, shared by everything the app does, so long jobs must not burst.
 */
export function pacer(gapMs: number, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let next = 0;
  return async function wait(): Promise<void> {
    const t = now();
    const start = Math.max(t, next);
    next = start + gapMs; // reserved before the first await, so concurrent callers queue behind each other
    if (start > t) await sleep(start - t);
  };
}
