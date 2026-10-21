import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface McpConfig {
  /** the stream service (live quotes and the paper API) */
  stream: string;
  /** the API service (curve, positioning) */
  api: string;
  /** may agents place, close and change paper trades? Off unless MCP_PAPER_WRITE=1 */
  write: boolean;
  /** the paper account used when a tool call does not name one */
  account: string;
  fetch?: typeof fetch;
}

export const MCX_SYMBOLS = ["MCX:CRUDEOIL", "MCX:CRUDEOILM", "MCX:NATURALGAS", "MCX:NATGASMINI"] as const;
const ALL_SYMBOLS = [...MCX_SYMBOLS, "NYMEX:CL", "NYMEX:NG"] as const;

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): Reply => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const err = (message: string): Reply => ({ content: [{ type: "text", text: message }], isError: true });

/**
 * MCP server for Divya Drishti. Read tools return live prices, the paper account, curve and positioning; write tools (only when
 * enabled) place, close and adjust SIMULATED paper trades. Every write goes through the stream's /paper API, which enforces the agent's
 * caps (lots per order, open positions, orders per day), refuses closed markets, and records an audit entry: the same account the
 * browser shows, so a trade placed here appears in the Paper panel within a second. There is no broker code in here or behind it.
 */
export function createServer(cfg: McpConfig) {
  const f = cfg.fetch ?? fetch;
  const server = new McpServer({ name: "divya-drishti", version: "1.0.0" });

  async function call(base: string, path: string, method = "GET", body?: unknown, actor = false) {
    const res = await f(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(actor ? { "x-drishti-actor": "mcp" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res) return { ok: false as const, error: "the Divya Drishti service is not reachable (is `bun run dev` running?)" };
    const json: any = await res.json().catch(() => ({}));
    return res.ok ? { ok: true as const, json } : { ok: false as const, error: json?.error ?? json?.message ?? `HTTP ${res.status}` };
  }
  const account = (a?: string) => encodeURIComponent(a || cfg.account);

  // ---- read tools
  server.registerTool(
    "get_quote",
    { description: "Latest live price for one contract (price, bid, ask, source, contract month, previous close). Says when two feeds disagree.", inputSchema: { symbol: z.enum(ALL_SYMBOLS) } },
    async ({ symbol }) => {
      const r = await call(cfg.stream, `/paper/quote/${encodeURIComponent(symbol)}`);
      return r.ok ? ok(r.json) : err(r.error);
    },
  );

  server.registerTool(
    "get_paper_account",
    { description: "The paper trading account: capital, equity, realised and open P&L, costs paid, win rate, and the limits that apply to agents.", inputSchema: { account: z.string().optional() } },
    async ({ account: a }) => {
      const r = await call(cfg.stream, `/paper/accounts/${account(a)}`, "GET", undefined, true);
      if (!r.ok) return err(r.error);
      const s = r.json.state;
      return ok({ account: s.account, summary: s.summary, openPositions: s.positions.length, limitsForAgents: s.limits, note: "Simulated: nothing reaches a broker. Open P&L here uses the server's last quote." });
    },
  );

  server.registerTool(
    "list_paper_positions",
    { description: "Open paper positions with entry, stop, target and who opened them.", inputSchema: { account: z.string().optional() } },
    async ({ account: a }) => {
      const r = await call(cfg.stream, `/paper/accounts/${account(a)}`, "GET", undefined, true);
      return r.ok ? ok(r.json.state.positions) : err(r.error);
    },
  );

  server.registerTool(
    "list_paper_trades",
    { description: "Closed paper trades, newest first, each with gross, costs, net, why it closed and who opened and closed it.", inputSchema: { account: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } },
    async ({ account: a, limit }) => {
      const r = await call(cfg.stream, `/paper/accounts/${account(a)}`, "GET", undefined, true);
      return r.ok ? ok(r.json.state.trades.slice(0, limit ?? 20)) : err(r.error);
    },
  );

  server.registerTool(
    "get_futures_curve",
    { description: "Futures curve for a contract: price per delivery month, calendar spreads, and whether it is in contango or backwardation.", inputSchema: { symbol: z.enum(ALL_SYMBOLS) } },
    async ({ symbol }) => {
      const r = await call(cfg.api, `/curve?symbol=${encodeURIComponent(symbol)}`);
      return r.ok ? ok({ summary: r.json.summary, points: r.json.points }) : err(r.error);
    },
  );

  server.registerTool(
    "get_speculator_positioning",
    { description: "Latest CFTC managed-money (speculator) positioning for WTI, Brent, RBOB or Henry Hub gas, with the change on the week. Weekly data, a few days old.", inputSchema: { market: z.enum(["wti", "brent", "natgas", "rbob"]) } },
    async ({ market }) => {
      const r = await call(cfg.api, `/cot?market=${market}&weeks=26`);
      if (!r.ok) return err(r.error);
      const rows = r.json.rows as any[];
      const last = rows[rows.length - 1];
      return ok({ market: r.json.market, reportDate: new Date(last.date).toISOString().slice(0, 10), managedMoney: last.managedMoney, openInterest: last.openInterest, note: "Positions as of the report date (a Tuesday), published the Friday after." });
    },
  );

  // ---- write tools: simulated trades only, and only when enabled
  if (cfg.write) {
    server.registerTool(
      "place_paper_order",
      {
        description: "Place a SIMULATED market order on an MCX contract in the paper account (never a real order). Fills at the live ask (buy) or bid (sell) plus slippage, with full Upstox costs. Refused when the market is closed, the feed is stale, the contract already has a position, or the agent limits are exceeded. Appears in the user's Paper panel immediately.",
        inputSchema: {
          symbol: z.enum(MCX_SYMBOLS),
          side: z.enum(["buy", "sell"]),
          lots: z.number().int().min(1),
          stop: z.number().positive().optional().describe("stop-loss price: below the entry for a buy, above for a sell"),
          target: z.number().positive().optional().describe("take-profit price: above the entry for a buy, below for a sell"),
          account: z.string().optional(),
        },
      },
      async ({ account: a, ...order }) => {
        const r = await call(cfg.stream, `/paper/accounts/${account(a)}/orders`, "POST", order, true);
        return r.ok ? ok({ filled: r.json.position, note: "Simulated fill. Visible in the Paper panel." }) : err(r.error);
      },
    );

    server.registerTool(
      "close_paper_position",
      { description: "Close an open paper position at the live market (simulated). Use list_paper_positions for the id.", inputSchema: { position_id: z.string(), account: z.string().optional() } },
      async ({ position_id, account: a }) => {
        const r = await call(cfg.stream, `/paper/accounts/${account(a)}/positions/${encodeURIComponent(position_id)}/close`, "POST", undefined, true);
        return r.ok ? ok({ closed: r.json.trade }) : err(r.error);
      },
    );

    server.registerTool(
      "set_paper_stop_target",
      {
        description: "Set, change or remove the stop and/or target of an open paper position. A number sets it, null removes it, leaving it out keeps it.",
        inputSchema: { position_id: z.string(), stop: z.number().positive().nullable().optional(), target: z.number().positive().nullable().optional(), account: z.string().optional() },
      },
      async ({ position_id, account: a, ...rest }) => {
        const r = await call(cfg.stream, `/paper/accounts/${account(a)}/positions/${encodeURIComponent(position_id)}`, "PATCH", rest, true);
        return r.ok ? ok({ position: r.json.position }) : err(r.error);
      },
    );
  }

  return server;
}

/** Settings from the environment. Writes are OFF unless MCP_PAPER_WRITE=1. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): McpConfig {
  return {
    stream: env.DRISHTI_STREAM_URL?.replace(/\/$/, "") || `http://127.0.0.1:${env.STREAM_PORT ?? 3002}`,
    api: env.DRISHTI_API_URL?.replace(/\/$/, "") || `http://127.0.0.1:${env.API_PORT ?? 3001}`,
    write: env.MCP_PAPER_WRITE === "1",
    account: env.MCP_PAPER_ACCOUNT?.trim() || "main",
  };
}
