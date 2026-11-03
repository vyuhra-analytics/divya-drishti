// Access control shared by drishti-core-api and drishti-core-stream. Pure, so it is unit-tested; the token files and the servers' wiring live in the apps.
//
// Three checks on every request, in this order:
//  1. Host: only our own names (localhost, 127.0.0.1, [::1], the Tauri host, plus ALLOWED_HOSTS). A page on another domain that was DNS-rebound to
//     127.0.0.1 still sends its own domain here, so it is refused before anything is read.
//  2. Origin: when the browser sends one it must be on the allow-list. A foreign website can therefore not make the server DO anything, which CORS alone
//     (it only hides the response) does not stop.
//  3. Token: a secret that only our own processes and the web app's dev proxy hold, sent as `x-drishti-token`. Two tokens exist so the caller's identity comes
//     from the secret it holds, not from a header it writes about itself: `ui` (the web app and our own services) and `mcp` (an agent, held to the agent caps).

export const TOKEN_HEADER = "x-drishti-token";

export type CallerKind = "ui" | "mcp";

/** Names the services answer to. `tauri.localhost` is the packaged desktop app's own host. */
export const DEFAULT_HOSTS = ["localhost", "127.0.0.1", "[::1]", "tauri.localhost"];

/** ALLOWED_HOSTS="a.example,b.example" adds to the defaults (needed only when HOST is not loopback). */
export function allowedHosts(env: string | undefined): string[] {
  const extra = (env ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_HOSTS, ...extra];
}

/** "Localhost:3001" -> "localhost"; "[::1]:3001" -> "[::1]". */
export function hostName(header: string | null | undefined): string {
  const h = (header ?? "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

/** Equal strings in time that does not depend on where they first differ. */
export function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export interface Tokens {
  ui: string;
  mcp: string;
}

/** Which kind of caller holds this token, or undefined. Empty tokens never match. */
export function tokenKind(given: string | null | undefined, tokens: Tokens): CallerKind | undefined {
  if (!given) return undefined;
  if (tokens.ui && sameSecret(given, tokens.ui)) return "ui";
  if (tokens.mcp && sameSecret(given, tokens.mcp)) return "mcp";
  return undefined;
}

export interface GuardInput {
  method: string;
  path: string;
  host: string | null | undefined;
  origin: string | null | undefined;
  /** the `x-drishti-token` header, or on a WebSocket upgrade also the `token` query parameter */
  token: string | null | undefined;
}

export interface GuardConfig {
  hosts: string[];
  origins: string[];
  /** null = access control switched off (DRISHTI_AUTH=off): host and origin are still checked */
  tokens: Tokens | null;
  /** paths that carry no token because a third party sends the browser there (the Upstox login callback); host and origin still apply */
  publicPaths?: string[];
}

export type GuardResult = { ok: true; kind: CallerKind } | { ok: false; status: 400 | 401 | 403; message: string };

export function guard(input: GuardInput, cfg: GuardConfig): GuardResult {
  if (!hostName(input.host)) return { ok: false, status: 400, message: "missing Host header" };
  if (!cfg.hosts.includes(hostName(input.host))) return { ok: false, status: 403, message: "unknown host" };
  const origin = input.origin?.replace(/\/+$/, "");
  if (origin && !cfg.origins.includes(origin)) return { ok: false, status: 403, message: "forbidden origin" };
  if (!cfg.tokens) return { ok: true, kind: "ui" };
  // a browser's preflight cannot carry the token; it only asks whether the real request may be sent, and only an allowed origin gets an answer
  if (input.method === "OPTIONS" && origin) return { ok: true, kind: "ui" };
  if (cfg.publicPaths?.includes(input.path)) return { ok: true, kind: "ui" };
  const kind = tokenKind(input.token, cfg.tokens);
  return kind ? { ok: true, kind } : { ok: false, status: 401, message: "missing or wrong access token" };
}
