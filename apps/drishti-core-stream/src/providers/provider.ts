import type { Quote } from "@drishti/shared";

export type Emit = (q: Quote) => void;

export interface ProviderStats {
  ok: number;
  failed: number;
  lastError: string | null;
  lastOkAt: number | null;
  latencyMs: number | null;
}

export const newStats = (): ProviderStats => ({ ok: 0, failed: 0, lastError: null, lastOkAt: null, latencyMs: null });

/** An error that carries how long to leave the provider alone (set on an HTTP 429). */
export type RateLimited = Error & { retryAfterMs?: number };

/** How long to wait after a 429: the provider's own `Retry-After` (seconds) when it sent a sensible one, else 30 s; never under 5 s or over 10 minutes. */
export function retryAfterMs(header: string | null): number {
  const s = header === null ? NaN : Number(header);
  return Math.min(600_000, Math.max(5_000, Number.isFinite(s) && s > 0 ? s * 1000 : 30_000));
}

/** Run fn every `ms` (after the previous run finishes), recording success/latency/errors. A 429 makes the next run wait out the provider's pause. Returns stop(). */
export function poll(ms: number, stats: ProviderStats, fn: () => Promise<void>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    let delay = ms;
    const t0 = Date.now();
    try {
      await fn();
      stats.ok++;
      stats.lastOkAt = Date.now();
      stats.latencyMs = Date.now() - t0;
    } catch (err) {
      stats.failed++;
      stats.lastError = (err as Error).message;
      // a provider that said "too many requests" is asked again after its own pause, not every `ms`: hammering it made TradingView answer 429 over a hundred times
      const wait = (err as RateLimited).retryAfterMs;
      if (typeof wait === "number") delay = Math.max(ms, wait);
    }
    if (!stopped) timer = setTimeout(run, delay);
  };
  run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** fetch that throws on non-2xx and gives up after `timeoutMs` */
export async function getJson(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err: RateLimited = new Error(`${new URL(url).host} ${res.status}`);
    if (res.status === 429) err.retryAfterMs = retryAfterMs(res.headers.get("retry-after"));
    throw err;
  }
  return res.json();
}
