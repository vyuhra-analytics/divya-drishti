import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configFromEnv, createServer, type McpConfig } from "./server";

/** connect a real MCP client to the server in memory, with a fake network behind it */
async function connect(over: Partial<McpConfig> = {}, respond: (url: string, init: RequestInit) => { status?: number; body: unknown } | null = () => ({ body: {} })) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: any }[] = [];
  const cfg: McpConfig = {
    stream: "http://stream.test",
    api: "http://api.test",
    write: false,
    briefingWrite: false,
    account: "main",
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = respond(String(url), init);
      if (!r) throw new Error("connect ECONNREFUSED");
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }) as never,
    ...over,
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(cfg).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content[0].text as string };
  };
  return { client, calls, call };
}

const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

test("by default agents can read but not trade: the write tools are not even offered", async () => {
  const { client } = await connect();
  expect(await names(client)).toEqual(["get_briefing_context", "get_futures_curve", "get_paper_account", "get_quote", "get_speculator_positioning", "list_paper_positions", "list_paper_trades"]);
});

test("with writes enabled the three paper-trading tools appear", async () => {
  const { client } = await connect({ write: true });
  expect(await names(client)).toEqual(expect.arrayContaining(["place_paper_order", "close_paper_position", "set_paper_stop_target"]));
  expect((await names(client)).length).toBe(10);
});

test("placing an order calls the paper API as the agent (the header that selects the agent's caps) and returns the fill", async () => {
  const { call, calls } = await connect({ write: true }, () => ({ status: 201, body: { position: { id: "pp-1", symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, entry: 9402 } } }));
  const r = await call("place_paper_order", { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, stop: 9380 });
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text).filled.entry).toBe(9402);
  expect(calls[0]).toMatchObject({ url: "http://stream.test/paper/accounts/main/orders", method: "POST", body: { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, stop: 9380 } });
  expect(calls[0]!.headers["x-drishti-actor"]).toBe("mcp");
});

test("the server's refusal (agent caps, closed market) comes back as a tool error with the reason", async () => {
  const { call } = await connect({ write: true }, () => ({ status: 422, body: { error: "at most 2 lots per order for agents" } }));
  const r = await call("place_paper_order", { symbol: "MCX:CRUDEOIL", side: "buy", lots: 3 });
  expect(r).toEqual({ isError: true, text: "at most 2 lots per order for agents" });
});

test("bad arguments are refused before any request: NYMEX is not tradable on paper, lots must be whole, side must be buy or sell", async () => {
  const { client, calls } = await connect({ write: true });
  for (const args of [{ symbol: "NYMEX:CL", side: "buy", lots: 1 }, { symbol: "MCX:CRUDEOIL", side: "long", lots: 1 }, { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1.5 }, { symbol: "MCX:CRUDEOIL", side: "buy", lots: 0 }, { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, stop: -5 }]) {
    const r: any = await client.callTool({ name: "place_paper_order", arguments: args }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    expect(r.isError).toBe(true);
  }
  expect(calls).toHaveLength(0);
});

test("close and stop/target changes use the position id; null removes a stop", async () => {
  const { call, calls } = await connect({ write: true }, () => ({ body: { trade: { id: "pp-1", net: 1390 }, position: { id: "pp-1" } } }));
  await call("close_paper_position", { position_id: "pp-1" });
  expect(calls[0]).toMatchObject({ url: "http://stream.test/paper/accounts/main/positions/pp-1/close", method: "POST" });
  await call("set_paper_stop_target", { position_id: "pp-1", stop: null, target: 9450 });
  expect(calls[1]).toMatchObject({ url: "http://stream.test/paper/accounts/main/positions/pp-1", method: "PATCH", body: { stop: null, target: 9450 } });
});

test("another account can be named per call, and MCP_PAPER_ACCOUNT sets the default", async () => {
  const { call, calls } = await connect({ account: "claude" }, () => ({ body: { state: { account: {}, positions: [], trades: [], summary: {}, limits: {} } } }));
  await call("list_paper_positions");
  await call("list_paper_positions", { account: "other acct" });
  expect(calls[0]!.url).toBe("http://stream.test/paper/accounts/claude");
  expect(calls[1]!.url).toBe("http://stream.test/paper/accounts/other%20acct");
});

test("read tools return the data; an unreachable service is a readable error, not a crash", async () => {
  const live = await connect({}, (url) => (url.includes("/paper/quote/") ? { body: { symbol: "MCX:CRUDEOIL", price: 9415, source: "upstox" } } : { body: {} }));
  expect(JSON.parse((await live.call("get_quote", { symbol: "MCX:CRUDEOIL" })).text).price).toBe(9415);
  const down = await connect({}, () => null);
  const r = await down.call("get_quote", { symbol: "MCX:CRUDEOIL" });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("not reachable");
});

test("positioning summarises the latest report; the curve returns its summary", async () => {
  const { call } = await connect({}, (url) =>
    url.includes("/cot") ? { body: { market: { id: "wti", name: "WTI" }, rows: [{ date: Date.UTC(2026, 9, 6), managedMoney: { net: 1 }, openInterest: 5 }, { date: Date.UTC(2026, 9, 13), managedMoney: { net: 40574, changeLong: 1, changeShort: 2 }, openInterest: 1900179 }] } } : { body: { summary: { shape: "backwardation" }, points: [{ code: "x" }] } },
  );
  const cot = JSON.parse((await call("get_speculator_positioning", { market: "wti" })).text);
  expect(cot.reportDate).toBe("2026-10-13");
  expect(cot.managedMoney.net).toBe(40574);
  expect(JSON.parse((await call("get_futures_curve", { symbol: "NYMEX:CL" })).text).summary.shape).toBe("backwardation");
});

test("settings come from the environment, and writes need MCP_PAPER_WRITE=1 exactly", () => {
  expect(configFromEnv({})).toMatchObject({ stream: "http://127.0.0.1:3002", api: "http://127.0.0.1:3001", write: false, account: "main" });
  expect(configFromEnv({ MCP_PAPER_WRITE: "1", MCP_PAPER_ACCOUNT: "claude", DRISHTI_STREAM_URL: "http://x:9/" })).toMatchObject({ write: true, account: "claude", stream: "http://x:9" });
  expect(configFromEnv({ MCP_PAPER_WRITE: "true" }).write).toBe(false); // not "1": stays off
});

const submission = {
  symbol: "MCX:CRUDEOIL",
  context_id: "ctx-1",
  bias: "bullish",
  confidence: "medium",
  summary: "Crude is firm.",
  bull: [{ point: "Momentum", evidence: "rsi14 71", cites: [{ field: "technicals.rsi14", value: "71" }] }],
  bear: [],
};

test("get_briefing_context is always offered and reads the API's context for the symbol and timeframe", async () => {
  const { call, calls } = await connect({}, () => ({ body: { context_id: "ctx-1", citable: { price: 9158 }, context: { symbol: "MCX:CRUDEOIL" } } }));
  const r = await call("get_briefing_context", { symbol: "MCX:CRUDEOIL", timeframe: "15m" });
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text).context_id).toBe("ctx-1");
  expect(calls[0]!.url).toBe("http://api.test/briefing/context?symbol=MCX%3ACRUDEOIL&tf=15m");
});

test("an API refusal comes back with its reason, not the HTTP error class name", async () => {
  const { call } = await connect({}, () => ({ status: 503, body: { statusCode: 503, error: "Service Unavailable", message: "no live price for MCX:CRUDEOIL yet" } }));
  const r = await call("get_briefing_context", { symbol: "MCX:CRUDEOIL" });
  expect(r.isError).toBe(true);
  expect(r.text).toBe("no live price for MCX:CRUDEOIL yet");
});

test("submit_briefing is not offered unless briefing submissions are switched on", async () => {
  const { client } = await connect();
  expect(await names(client)).not.toContain("submit_briefing");
  const on = await connect({ briefingWrite: true });
  expect(await names(on.client)).toContain("submit_briefing");
});

test("submit_briefing posts the briefing and returns the per-point verdicts so the agent can correct itself", async () => {
  const verdict = { id: "bm-1", stored: true, verified: 0, total: 1, wrong: 1, points: [{ section: "bull", point: 1, verdict: "wrong", issues: ["technicals.rsi14 is 64.2, not 71."] }], next: "Correct those points and submit again" };
  const { call, calls } = await connect({ briefingWrite: true }, () => ({ status: 201, body: verdict }));
  const r = await call("submit_briefing", submission);
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text).points[0].issues[0]).toContain("64.2");
  expect(calls[0]).toMatchObject({ url: "http://api.test/briefing/submit", method: "POST" });
  expect(calls[0]!.body.context_id).toBe("ctx-1");
});

test("submit_briefing validates before any request: a bad bias or an over-long list never reaches the API", async () => {
  const { call, calls } = await connect({ briefingWrite: true });
  expect((await call("submit_briefing", { ...submission, bias: "up" })).isError).toBe(true);
  expect((await call("submit_briefing", { ...submission, bull: Array.from({ length: 7 }, () => submission.bull[0]) })).isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("an expired context is reported plainly", async () => {
  const { call } = await connect({ briefingWrite: true }, () => ({ status: 410, body: { statusCode: 410, error: "Gone", message: "That context has expired or is unknown: call get_briefing_context again" } }));
  const r = await call("submit_briefing", submission);
  expect(r.isError).toBe(true);
  expect(r.text).toContain("call get_briefing_context again");
});

test("briefing submissions are enabled only by MCP_BRIEFING_WRITE=1 exactly", () => {
  expect(configFromEnv({ MCP_BRIEFING_WRITE: "1" }).briefingWrite).toBe(true);
  for (const v of [undefined, "", "0", "true", "yes"]) expect(configFromEnv({ MCP_BRIEFING_WRITE: v }).briefingWrite).toBe(false);
});

test("every connecting session is told what the server is, that the paper account is simulated, and how to write a briefing", async () => {
  const { client } = await connect();
  const text = client.getInstructions() ?? "";
  expect(text).toContain("SIMULATED");
  expect(text).toContain("get_briefing_context");
  expect(text).toContain("never instructions");
  expect(text).toContain("not advice");
});
