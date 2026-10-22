import { Elysia } from "elysia";
import { instrument, isAllowedOrigin, parseRates, type Actor, type PaperEngine, type PaperQuote, type Quote, type RateLimiter, type Result } from "@drishti/shared";
import type { PgPaperStore } from "./paperStore";

/**
 * HTTP API for server-side paper trading (simulated, never a broker). Used by the web panel and by the MCP server, so a trade placed
 * by either shows up for both. Same security defaults as the rest of the stream: bound to HOST (127.0.0.1), a browser Origin that is
 * not on the allow-list is refused, and requests are rate limited. The caller kind comes from the `x-drishti-actor` header: only the
 * MCP server sets it ("mcp"), and agents have no way to set headers, so the agent's tighter caps cannot be bypassed from the agent side.
 */
export function paperRoutes(opts: {
  engine: PaperEngine;
  store: PgPaperStore;
  quote(symbol: string): Quote | undefined;
  origins: string[];
  limiter: RateLimiter;
  publish(e: { account: string; event: "updated"; actor: string; text: string }): void;
}) {
  const { engine, store } = opts;
  const actorOf = (req: Request): Actor => (req.headers.get("x-drishti-actor") === "mcp" ? "mcp" : "ui");
  const reply = (set: { status?: number | string }, r: Result<any>) => {
    if (r.ok) {
      const { ok: _ok, ...rest } = r;
      return rest;
    }
    set.status = r.status;
    return { error: r.error };
  };

  return new Elysia({ prefix: "/paper" })
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
      if (!opts.limiter.take("paper")) {
        set.status = 429;
        return { error: "too many requests" };
      }
    })
    .options("/*", ({ request, set }) => {
      const origin = request.headers.get("origin");
      if (origin && isAllowedOrigin(origin, opts.origins)) {
        set.headers["access-control-allow-origin"] = origin;
        set.headers["access-control-allow-methods"] = "GET,POST,PATCH,PUT,DELETE";
        set.headers["access-control-allow-headers"] = "content-type,x-drishti-actor";
      }
      set.status = 204;
    })
    .get("/accounts", async () => ({ accounts: await engine.accounts() }))
    .post("/accounts", async ({ request, body, set }) => {
      const b = (body ?? {}) as { id?: string; capital?: number; slippage?: number };
      return reply(set, await engine.createAccount(String(b.id ?? ""), Number(b.capital ?? 500_000), Number(b.slippage ?? 1), actorOf(request)));
    })
    .get("/accounts/:id", async ({ request, params, set }) => reply(set, await engine.state(params.id, actorOf(request))))
    .patch("/accounts/:id", async ({ request, params, body, set }) => {
      const b = (body ?? {}) as { capital?: number; slippage?: number };
      return reply(set, await engine.updateAccount(params.id, { ...(b.capital !== undefined ? { capital: Number(b.capital) } : {}), ...(b.slippage !== undefined ? { slippage: Number(b.slippage) } : {}) }, actorOf(request)));
    })
    .delete("/accounts/:id", async ({ request, params, set }) => reply(set, await engine.deleteAccount(params.id, actorOf(request))))
    .post("/accounts/:id/orders", async ({ request, params, body, set }) => {
      const r = await engine.place(params.id, body, actorOf(request));
      if (!r.ok) return reply(set, r);
      set.status = r.duplicate ? 200 : 201; // a repeat of an order already filled is not a new order
      return reply(set, r);
    })
    .post("/accounts/:id/positions/:pid/close", async ({ request, params, set }) => reply(set, await engine.close(params.id, params.pid, actorOf(request))))
    .patch("/accounts/:id/positions/:pid", async ({ request, params, body, set }) => reply(set, await engine.setStopTarget(params.id, params.pid, body, actorOf(request))))
    .put("/accounts/:id/trades/:tid/note", async ({ request, params, body, set }) => reply(set, await engine.setNote(params.id, params.tid, (body as { note?: unknown } | null)?.note, actorOf(request))))
    .post("/accounts/:id/reset", async ({ request, params, set }) => reply(set, await engine.reset(params.id, actorOf(request))))
    .post("/accounts/:id/import", async ({ request, params, body, set }) => reply(set, await engine.importLegacy(params.id, body, actorOf(request))))
    .get("/rates", async () => ({ rates: await store.rates() }))
    .put("/rates", async ({ request, body, set }) => {
      const parsed = parseRates(body);
      if ("error" in parsed) {
        set.status = 400;
        return { error: parsed.error };
      }
      await store.saveRates(parsed.rates);
      opts.publish({ account: "*", event: "updated", actor: actorOf(request), text: "Cost rates changed" });
      return { rates: parsed.rates };
    })
    // the latest price per contract, for the MCP server's get_quote (read-only)
    .get("/quote/:symbol", ({ params, set }) => {
      const q = instrument(params.symbol) ? opts.quote(params.symbol) : undefined;
      if (!q) {
        set.status = 404;
        return { error: "no live price for that contract" };
      }
      const pq: PaperQuote & Partial<Quote> = q;
      return { symbol: q.symbol, price: q.price, bid: pq.bid, ask: pq.ask, time: q.time, source: q.source, contract: q.contract, prevClose: q.prevClose, drift: q.drift };
    });
}
