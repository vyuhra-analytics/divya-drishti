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
