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

/** Run fn every `ms` (after the previous run finishes), recording success/latency/errors. Returns stop(). */
export function poll(ms: number, stats: ProviderStats, fn: () => Promise<void>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    const t0 = Date.now();
    try {
      await fn();
      stats.ok++;
      stats.lastOkAt = Date.now();
      stats.latencyMs = Date.now() - t0;
    } catch (err) {
      stats.failed++;
      stats.lastError = (err as Error).message;
    }
    if (!stopped) timer = setTimeout(run, ms);
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
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}
