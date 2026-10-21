import { Elysia } from "elysia";
import { INSTRUMENTS, isAllowedOrigin, parseCustomInstrument, type Instrument, type RateLimiter } from "@drishti/shared";

/** The form fields behind a custom instrument: what is stored, and what the validator is run on again at every load. */
export const formOf = (i: Instrument) => ({ exchange: i.exchange, root: i.symbol.split(":")[1], name: i.name, decimals: i.decimals, lot: i.lot, topic: i.topic, upstox: i.upstox, tv: i.tv, yahoo: i.yahoo });

/**
 * Add / remove / list tracked instruments (Settings → Instruments). Same guards as /paper: browser Origin on the allow-list, rate limited.
 * Built-ins cannot be removed; an added one cannot be removed while a paper position is open in it.
 */
export function instrumentRoutes(opts: {
  origins: string[];
  limiter: RateLimiter;
  /** does Upstox list a future for this MCX underlying? (so a typo is refused instead of silently never getting a price) */
  upstoxHasFuture(underlying: string): Promise<boolean>;
  hasOpenPosition(symbol: string): Promise<boolean>;
  save(i: Instrument): Promise<void>;
  remove(symbol: string): Promise<void>;
  /** reload the live catalogue from the database and wake the feeds */
  changed(): Promise<void>;
}) {
  return new Elysia({ prefix: "/instruments" })
    .onBeforeHandle(({ request, set }) => {
      const origin = request.headers.get("origin");
      if (!isAllowedOrigin(origin, opts.origins)) {
        set.status = 403;
        return { error: "forbidden origin" };
      }
      if (origin) {
        set.headers["access-control-allow-origin"] = origin;
        set.headers["vary"] = "Origin";
      }
      if (!opts.limiter.take("instruments")) {
        set.status = 429;
        return { error: "too many requests" };
      }
    })
    .options("/*", ({ request, set }) => {
      const origin = request.headers.get("origin");
      if (origin && isAllowedOrigin(origin, opts.origins)) {
        set.headers["access-control-allow-origin"] = origin;
        set.headers["access-control-allow-methods"] = "GET,POST,DELETE";
        set.headers["access-control-allow-headers"] = "content-type";
      }
      set.status = 204;
    })
    .get("", () => ({ instruments: INSTRUMENTS }))
    .post("", async ({ body, set }) => {
      const r = parseCustomInstrument(body);
      if ("error" in r) {
        set.status = 400;
        return { error: r.error };
      }
      const i = r.instrument;
      if (i.upstox && !(await opts.upstoxHasFuture(i.upstox))) {
        set.status = 400;
        return { error: `Upstox lists no ${i.upstox} future (check the underlying name in its MCX instrument file)` };
      }
      await opts.save(i);
      await opts.changed();
      set.status = 201;
      return { instrument: i };
    })
    .delete("/:symbol", async ({ params, set }) => {
      const symbol = decodeURIComponent(params.symbol);
      const found = INSTRUMENTS.find((i) => i.symbol === symbol);
      if (!found?.custom) {
        set.status = found ? 403 : 404;
        return { error: found ? "built-in instruments cannot be removed" : "no such instrument" };
      }
      if (await opts.hasOpenPosition(symbol)) {
        set.status = 409;
        return { error: `close the open paper position in ${symbol} first` };
      }
      await opts.remove(symbol);
      await opts.changed();
      return { removed: symbol };
    });
}
