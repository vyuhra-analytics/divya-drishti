// Record-and-replay HTTP for provider tests. A fixture is a REAL response saved once (`bun run fixtures:refresh`), so a parser
// is checked against what the provider actually sends, and refreshing shows when the provider changes its format.
// Pure (no file access): the recorder script and the tests read and write the JSON.
import type { FetchIO } from "./fetcher";

export interface Recorded {
  method: string;
  /** the request URL with credentials removed */
  url: string;
  body?: string;
  status: number;
  contentType: string;
  text: string;
  /** ISO time of recording; replay runs the clock from here, so dated contract codes and year files match */
  recordedAt: string;
}

const SECRET_PARAMS = ["api_key", "apikey", "key", "token", "access_token"];

/** Drop credential query parameters so a key can never be written into a fixture or matched against one. */
export function scrubUrl(input: string | URL): string {
  const u = new URL(String(input));
  for (const p of SECRET_PARAMS) u.searchParams.delete(p);
  return u.toString();
}

const keyOf = (method: string, url: string, body?: string) => `${method} ${scrubUrl(url)} ${body ?? ""}`;

/** Wrap a FetchIO so every response it returns is also appended to `sink` (the caller writes the file). */
export function recordingIO(io: FetchIO, sink: Recorded[]): FetchIO {
  return {
    ...io,
    async fetch(input, init) {
      const res = await io.fetch(input, init);
      const text = await res.clone().text();
      sink.push({
        method: (init?.method ?? "GET").toUpperCase(),
        url: scrubUrl(input),
        body: typeof init?.body === "string" ? init.body : undefined,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        text,
        recordedAt: new Date(io.now()).toISOString(),
      });
      return res;
    },
  };
}

/**
 * A FetchIO that answers only from recorded responses (an unrecorded request is an error saying what was asked, never a live call).
 * The clock stands at the recording time, and any needed credential is set to a dummy so keyed sources run.
 */
export function replayIO(entries: Recorded[], env: Record<string, string | undefined> = {}): FetchIO {
  const byKey = new Map(entries.map((e) => [keyOf(e.method, e.url, e.body), e]));
  const at = entries.length ? Date.parse(entries[0].recordedAt) : Date.now();
  return {
    env,
    now: () => at,
    async fetch(input, init) {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      const hit = byKey.get(keyOf(method, String(input), body));
      if (!hit) throw new Error(`no recorded response for ${method} ${scrubUrl(input)}${body ? ` ${body.slice(0, 80)}` : ""}: refresh the fixtures`);
      return new Response(hit.text, { status: hit.status, headers: { "content-type": hit.contentType } });
    },
  };
}

/** Keep fixtures small: JSON arrays under `features`/the root and RSS items are cut to `maxItems`; CSV keeps its header and the lines `keepLine` accepts. */
export function shrink(e: Recorded, opts: { maxItems?: number; keepLine?: (line: string) => boolean } = {}): Recorded {
  let text = e.text;
  const items = text.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  const [firstItem, lastItem] = [items[0], items[items.length - 1]];
  if (firstItem && lastItem) {
    // RSS: keep the channel head, the first items and the tail
    return { ...e, text: text.slice(0, text.indexOf(firstItem)) + items.slice(0, opts.maxItems ?? 20).join("\n") + text.slice(text.lastIndexOf(lastItem) + lastItem.length) };
  }
  try {
    const json = JSON.parse(text);
    const cut = opts.maxItems ?? 400;
    if (Array.isArray(json)) text = JSON.stringify(json.slice(0, cut));
    else if (Array.isArray(json?.features)) text = JSON.stringify({ ...json, features: json.features.slice(0, cut) });
  } catch {
    if (opts.keepLine) {
      const [head, ...lines] = text.split("\n");
      text = [head, ...lines.filter(opts.keepLine)].join("\n");
    }
  }
  return { ...e, text };
}
