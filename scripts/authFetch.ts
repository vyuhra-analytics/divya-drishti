// Import first in a script that calls the local services: adds the access token to every fetch to the API (3001) and the stream (3002) unless the call set one itself.
import { internalHeaders } from "../packages/shared/src/authNode";

const UI = internalHeaders("ui");
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(3001|3002|3012)\b/.test(url)) return realFetch(input, init);
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const [k, v] of Object.entries(UI)) if (!h.has(k)) h.set(k, v);
  return realFetch(input, { ...init, headers: h });
}) as typeof fetch;
