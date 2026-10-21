// Server hardening shared by drishti-core-api and drishti-core-stream. Pure, so it's unit-tested.

/** Web app origins allowed to call our services: Vite dev server and the Tauri webview (macOS/Linux and Windows forms). */
export const DEFAULT_WEB_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

/** WEB_ORIGINS="https://a,https://b" replaces the defaults (e.g. a packaged or remote web build). */
export function allowedOrigins(env: string | undefined): string[] {
  const list = (env ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : DEFAULT_WEB_ORIGINS;
}

/**
 * Browsers always send Origin on cross-origin and WebSocket requests, so a foreign web page can be refused.
 * No Origin = not a browser page (curl, server-to-server, top-level navigation like the OAuth callback): allowed.
 */
export function isAllowedOrigin(origin: string | null | undefined, allowed: string[]): boolean {
  return !origin || allowed.includes(origin.replace(/\/+$/, ""));
}

/**
 * Fixed-window limiter keyed by client (IP or connection). Old windows are swept, and the map has a hard cap (`maxKeys`: past it the
 * oldest key is dropped), so a flood of distinct keys inside one window cannot grow memory without bound.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** true = allowed, false = over the limit for this window */
  take(key: string, now = Date.now()): boolean {
    if (now - this.lastSweep > this.windowMs) {
      for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
      this.lastSweep = now;
    }
    const h = this.hits.get(key);
    if (!h || now >= h.resetAt) {
      this.hits.delete(key); // re-insert at the end so insertion order stays oldest-first
      if (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    return ++h.count <= this.max;
  }

  /** ms until the key's window resets (for Retry-After) */
  retryAfterMs(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    return h ? Math.max(0, h.resetAt - now) : 0;
  }

  get size() {
    return this.hits.size;
  }
}

/**
 * Bun RedisClient options for both services. Fail fast while disconnected (no offline queue: callers fall back),
 * but never stop reconnecting — the default gives up after 10 attempts, so Redis starting late or restarting
 * would silently disable the Upstox token and news cache until the service restarts.
 */
export const REDIS_OPTIONS = {
  enableOfflineQueue: false,
  connectionTimeout: 2000,
  autoReconnect: true,
  maxRetries: 4_294_967_295, // Bun's maximum (u32): effectively forever
};
