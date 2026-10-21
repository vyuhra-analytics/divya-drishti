// Provider contract: every external data source is a Fetcher with three steps, so caching, stale fallback, credential hints and
// tests live in one place instead of being rewritten in every controller. Shape borrowed from OpenBB's Fetcher (original code):
//   key       the cache key, from an already validated query
//   extract   the only step that touches the network or a key
//   transform raw response -> our standard model (the shapes in cot.ts, curve.ts, jodi.ts ... are the standard models)
// `fetch`, the environment and the clock are injected, so the same code runs against recorded responses in tests.
import { LruCache } from "./lru";
import { withUserAgent } from "./userAgents";

export interface FetchIO {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
  now: () => number;
}

export interface Fetcher<Q, Raw, R> {
  id: string;
  label: string;
  website: string;
  /** environment variables that must be set; a missing one gives a "how to get a key" error instead of a failed request */
  credentials?: readonly string[];
  /** shown with the credentials error */
  instructions?: string;
  /** how long a result is fresh */
  ttlMs: number;
  key(q: Q): string;
  extract(q: Q, io: FetchIO): Promise<Raw>;
  transform(raw: Raw, q: Q, io: FetchIO): R;
  /** false for an empty or implausible result: treated as a failed fetch, so a bad response never replaces a good copy */
  isUsable(r: R): boolean;
}

export type SourceErrorKind = "credentials" | "unavailable";

export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface Served<R> {
  data: R;
  /** when this copy was fetched, epoch ms */
  fetchedAt: number;
  /** true when the source failed and this is the last good copy */
  stale?: boolean;
}

const RETRY_MS = 5 * 60_000; // after a failure with a copy in hand, leave the source alone this long

/** One runner per process: a capped cache, one request per key in flight, and the last good copy when the source is down. */
export function createRunner(io: FetchIO = { fetch: (input, init) => fetch(input, withUserAgent(input, init)), env: process.env, now: Date.now }, cacheSize = 64) {
  const cache = new LruCache<{ at: number; data: unknown; nextTry?: number }>(cacheSize);
  const inflight = new Map<string, Promise<Served<unknown>>>();

  async function load<Q, Raw, R>(f: Fetcher<Q, Raw, R>, q: Q, k: string): Promise<Served<R>> {
    const hit = cache.get(k) as { at: number; data: R } | undefined;
    try {
      const raw = await f.extract(q, io);
      const data = f.transform(raw, q, io);
      if (!f.isUsable(data)) throw new Error("empty or implausible result");
      const at = io.now();
      cache.set(k, { at, data });
      return { data, fetchedAt: at };
    } catch (e) {
      if (hit) {
        cache.set(k, { at: hit.at, data: hit.data, nextTry: io.now() + RETRY_MS }); // keep the real fetch time; pause before the next attempt
        return { data: hit.data, fetchedAt: hit.at, stale: true };
      }
      throw new SourceError("unavailable", `${f.label} unavailable: ${(e as Error).message}`);
    }
  }

  return async function run<Q, Raw, R>(f: Fetcher<Q, Raw, R>, q: Q): Promise<Served<R>> {
    const missing = (f.credentials ?? []).filter((name) => !io.env[name]?.trim());
    if (missing.length) throw new SourceError("credentials", `Set ${missing.join(", ")} in .env${f.instructions ? ` (${f.instructions})` : ""}`);
    const k = `${f.id}|${f.key(q)}`;
    const hit = cache.get(k) as { at: number; data: R; nextTry?: number } | undefined;
    if (hit?.nextTry !== undefined && io.now() < hit.nextTry) return { data: hit.data, fetchedAt: hit.at, stale: true }; // source failed recently: no new attempt yet
    if (hit && hit.nextTry === undefined && io.now() - hit.at < f.ttlMs) return { data: hit.data, fetchedAt: hit.at };
    const running = inflight.get(k) as Promise<Served<R>> | undefined;
    if (running) return running; // a second panel asking for the same thing shares the one request
    const p = load(f, q, k).finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  };
}

export type Runner = ReturnType<typeof createRunner>;
