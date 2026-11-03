import { TOKEN_HEADER } from "@drishti/shared";
import { apiUrl, streamHttpUrl, streamUrl, useSettings } from "./settings";

// The services want an access token on every request. In browser dev the Vite proxy adds it, so a relative URL (/api, /stream, /ws) needs nothing here. A build that
// talks to the services directly (the packaged desktop app, or a URL typed in Settings) holds the token itself: from Settings (accessToken) or VITE_DRISHTI_TOKEN. It is
// only ever sent to the origins of those two service URLs, never to another site.

const token = () => useSettings.getState().accessToken.trim() || (import.meta.env.VITE_DRISHTI_TOKEN as string | undefined)?.trim() || "";

const originOf = (u: string) => {
  try {
    return new URL(u, location.href).origin;
  } catch {
    return undefined;
  }
};

/** The origins the token may go to: our two services, when they are not the page's own origin (the dev proxy case). */
export function serviceOrigins(): string[] {
  const own = location.origin;
  const wsAsHttp = streamUrl().replace(/^ws/, "http");
  return [...new Set([originOf(apiUrl()), originOf(streamHttpUrl("/")), originOf(wsAsHttp)].filter((o): o is string => !!o && o !== own))];
}

/** Puts the token on fetches to our services. */
export function installAuthFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const t = token();
    if (!t) return original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const o = originOf(url);
    if (!o || !serviceOrigins().includes(o)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(TOKEN_HEADER, t);
    return original(input, { ...init, headers });
  }) as typeof fetch;
}

/** A browser cannot set headers on a WebSocket, so a direct connection carries the token in the address. A proxied one (same origin) does not. */
export function streamSocketUrl(): string {
  const url = streamUrl();
  const t = token();
  const o = originOf(url.replace(/^ws/, "http"));
  if (!t || !o || o === location.origin) return url;
  const u = new URL(url);
  u.searchParams.set("token", t);
  return u.toString();
}
