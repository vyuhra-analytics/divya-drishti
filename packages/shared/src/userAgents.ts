// A small pool of ordinary browser User-Agent strings instead of one hardcoded string repeated across the code: the same string on
// every request from every source is itself a fingerprint. One UA is kept per host for the life of the process (a site sees a consistent
// client), and a restart may pick a different one. Not an evasion tool: no spoofing of anything but the UA, and sec.gov, which asks
// for an honest contact, gets its own header (insider.controller.ts) and never comes from this pool.

export const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
] as const;

const PROCESS_SEED = Math.floor(Math.random() * 2 ** 31);

/** Small stable string hash (FNV-1a). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The UA for a host (or a URL: its host is used). Same answer for the same host within a process. */
export function userAgentFor(hostOrUrl: string, seed = PROCESS_SEED): string {
  let host = hostOrUrl;
  try {
    host = new URL(hostOrUrl).hostname;
  } catch {
    /* already a bare host */
  }
  return USER_AGENTS[hash(`${seed}:${host}`) % USER_AGENTS.length]!;
}

/** `{ "User-Agent": … }` ready to spread into request headers. */
export const uaHeader = (hostOrUrl: string, seed?: number) => ({ "User-Agent": userAgentFor(hostOrUrl, seed) });

/**
 * Official data hosts get no browser disguise: they do not need it, and some are worse for it (FRED stalls for 20 s on a browser
 * User-Agent but answers instantly to the runtime's default). Only unofficial, scrape-like sources (TradingView, Yahoo, news feeds,
 * Forex Factory) use the pool.
 */
export const OFFICIAL_HOSTS = [
  "fred.stlouisfed.org",
  "ir.eia.gov",
  "api.eia.gov",
  "publicreporting.cftc.gov",
  "services9.arcgis.com",
  "www.jodidata.org",
  "data.sec.gov",
  "www.sec.gov",
  "api.upstox.com",
  "assets.upstox.com",
  "api.anthropic.com",
] as const;

const hostOf = (input: string | URL) => {
  try {
    return new URL(String(input)).hostname;
  } catch {
    return String(input);
  }
};

/** `init` with a pool User-Agent added when the caller did not set one and the host is not an official data host (plain-object headers only, as everywhere in this codebase). */
export function withUserAgent(input: string | URL, init: RequestInit = {}): RequestInit {
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (Object.keys(headers).some((k) => k.toLowerCase() === "user-agent")) return init;
  if ((OFFICIAL_HOSTS as readonly string[]).includes(hostOf(input))) return init;
  return { ...init, headers: { ...uaHeader(String(input)), ...headers } };
}
