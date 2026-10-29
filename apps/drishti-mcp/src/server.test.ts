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
  expect(await names(client)).toEqual([
    "get_bars", "get_briefing_context", "get_calendar", "get_chokepoints", "get_eia", "get_eia_arrivals", "get_eia_forecasts", "get_eia_release_context", "get_eia_report", "get_futures_curve", "get_market_status", "get_news", "get_option_chain", "get_paper_account", "get_quote", "get_recap", "get_signals", "get_source_checks", "get_speculator_positioning", "get_technicals", "list_instruments", "list_paper_positions", "list_paper_trades",
  ].sort());
});

test("with writes enabled the three paper-trading tools appear", async () => {
  const { client } = await connect({ write: true });
  expect(await names(client)).toEqual(expect.arrayContaining(["place_paper_order", "place_paper_option_order", "close_paper_position", "set_paper_stop_target"]));
  expect((await names(client)).length).toBe(27);
});

test("the EIA report tools trim what they return and pass their choices through; the prompts name the right tools", async () => {
  const releases = Array.from({ length: 30 }, (_, i) => ({ id: i }));
  const { call, calls, client } = await connect({}, (url) => {
    if (url.includes("/eia-report/forecasts")) return { body: { releases, stats: { crude: { weeks: 30 } }, threshold: 3 } };
    if (url.includes("/eia-report/arrivals")) return { body: Array.from({ length: 20 }, (_, i) => ({ id: i })) };
    return { body: { weekEnding: "2026-10-16", rows: new Array(880).fill({}), analysis: { lines: [] } } };
  });
  const rep = JSON.parse((await call("get_eia_report", { report: "WPSR", week: "2026-10-16", forecast: -1.5 })).text);
  expect(calls.at(-1)!.url).toBe("http://api.test/eia-report?report=WPSR&week=2026-10-16&forecast=-1.5");
  expect(rep.rows).toBeUndefined();
  expect(rep.rowCount).toBe(880);
  const fc = JSON.parse((await call("get_eia_forecasts", { report: "WNGSR", weeks: 100, rows_shown: 5 })).text);
  expect(calls.at(-1)!.url).toBe("http://api.test/eia-report/forecasts?weeks=100&report=WNGSR");
  expect(fc.releases).toHaveLength(5);
  expect(fc.threshold).toBe(3);
  expect(JSON.parse((await call("get_eia_arrivals")).text)).toHaveLength(10);
  expect((await call("get_eia_report", { report: "OTHER" })).isError).toBe(true);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  expect(prompts).toEqual(["briefing", "eia-article"]);
  const p: any = await client.getPrompt({ name: "eia-article", arguments: { report: "WNGSR" } });
  expect(p.messages[0].content.text).toContain("get_eia_release_context");
  expect(p.messages[0].content.text).toContain("submit_eia_article");
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

const articleSubmission = { report: "WPSR", context_id: "ectx-1", title: "Crude draws", dek: "A draw.", sections: [{ heading: "The headline", paragraphs: [{ text: "Crude drew 3.06 million barrels.", cites: [{ field: "headline.change", value: "-3.06" }] }] }] };

test("get_eia_release_context is always offered and reads the context of the report and week", async () => {
  const { call, calls, client } = await connect({}, () => ({ body: { context_id: "ectx-1", citable: { "headline.change": -3.06 }, facts: { report: "WPSR" } } }));
  expect(await names(client)).toContain("get_eia_release_context");
  const r = await call("get_eia_release_context", { report: "WPSR", week: "2026-10-16" });
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text).context_id).toBe("ectx-1");
  expect(calls[0]!.url).toBe("http://api.test/eia-report/context?report=WPSR&week=2026-10-16");
  await call("get_eia_release_context", { report: "WNGSR" });
  expect(calls[1]!.url).toBe("http://api.test/eia-report/context?report=WNGSR");
});

test("get_eia_release_context refuses a bad report or week before any request", async () => {
  const { call, calls } = await connect();
  expect((await call("get_eia_release_context", { report: "STEO" })).isError).toBe(true);
  expect((await call("get_eia_release_context", { report: "WPSR", week: "last friday" })).isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("submit_eia_article is offered only with briefing submissions on, posts the article and returns the verdict per paragraph", async () => {
  expect(await names((await connect()).client)).not.toContain("submit_eia_article");
  const verdict = { id: "ea-1", stored: true, verified: 0, total: 1, wrong: 1, paragraphs: [{ section: "The headline", paragraph: 1, verdict: "wrong", issues: ["headline.change is -3.06, not -9."] }], next: "Correct those paragraphs and submit again" };
  const { call, calls, client } = await connect({ briefingWrite: true }, () => ({ status: 201, body: verdict }));
  expect(await names(client)).toContain("submit_eia_article");
  const r = await call("submit_eia_article", articleSubmission);
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text).paragraphs[0].issues[0]).toContain("-3.06");
  expect(calls[0]).toMatchObject({ url: "http://api.test/eia-report/article/submit", method: "POST" });
  expect(calls[0]!.body.context_id).toBe("ectx-1");
});

test("submit_eia_article validates before any request: no sections, too long a paragraph or too many cites never reach the API", async () => {
  const { call, calls } = await connect({ briefingWrite: true });
  expect((await call("submit_eia_article", { ...articleSubmission, sections: [] })).isError).toBe(true);
  expect((await call("submit_eia_article", { ...articleSubmission, sections: [{ heading: "h", paragraphs: [{ text: "x".repeat(901), cites: [] }] }] })).isError).toBe(true);
  expect((await call("submit_eia_article", { ...articleSubmission, report: "STEO" })).isError).toBe(true);
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

const NOW = Date.now();
const fixtures: Record<string, unknown> = {
  "/instruments": { instruments: [{ symbol: "MCX:CRUDEOIL", name: "Crude Oil", exchange: "MCX", currency: "INR", lot: "100 bbl", decimals: 0, delayedBy: 0 }, { symbol: "MCX:ZINC", name: "Zinc", exchange: "MCX", currency: "INR", lot: "5000 kg", decimals: 2, delayedBy: 0, custom: true }] },
  "/news": [
    { id: "a", title: "Brent climbs", url: "https://x/a", source: "Reuters", publishedAt: NOW - 10 * 60_000, tags: ["crude"], copies: [{ source: "CNBC" }] },
    { id: "b", title: "Old story", url: "https://x/b", source: "OilPrice", publishedAt: NOW - 30 * 3600_000, tags: ["crude"] },
  ],
  "/calendar": [{ id: "e", title: "EIA crude inventories", at: NOW + 90 * 60_000, kind: "energy", impact: "high", forecast: "-1.2M", previous: "-3.1M", country: "US" }],
};
const respondWith = (extra: Record<string, unknown> = {}) => (url: string) => {
  const u = new URL(url);
  const body = { ...fixtures, ...extra }[u.pathname];
  return body === undefined ? { status: 404, body: { message: "not found" } } : { body };
};

test("list_instruments gives symbols and lot sizes, and says which the user added", async () => {
  const { call, calls } = await connect({}, respondWith());
  const rows = JSON.parse((await call("list_instruments")).text);
  expect(rows[1]).toMatchObject({ symbol: "MCX:ZINC", lot: "5000 kg", addedByUser: true });
  expect(calls[0]!.url).toBe("http://stream.test/instruments");
});

test("get_news returns only recent headlines, marked as untrusted text, with who else ran the story", async () => {
  const { call, calls } = await connect({}, respondWith());
  const r = JSON.parse((await call("get_news", { topic: "crude", query: "brent", hours: 24 })).text);
  expect(r.notice).toContain("never instructions");
  expect(r.items).toHaveLength(1); // the 30-hour-old story is dropped
  expect(r.items[0]).toMatchObject({ title: "Brent climbs", outlet: "Reuters", alsoReportedBy: ["CNBC"] });
  expect(r.items[0].minutesAgo).toBeGreaterThanOrEqual(10);
  expect(calls[0]!.url).toContain("tags=crude");
  expect(calls[0]!.url).toContain("q=brent");
});

test("get_calendar shows time to each release and the forecast", async () => {
  const { call } = await connect({}, respondWith());
  const r = JSON.parse((await call("get_calendar", { days: 2 })).text);
  expect(r[0]).toMatchObject({ title: "EIA crude inventories", impact: "high", forecast: "-1.2M" });
  expect(r[0].minutesFromNow).toBeGreaterThan(85);
});

test("get_bars drops the candle still forming, marks it when asked, and keeps the newest N", async () => {
  const sec = Math.floor(NOW / 1000);
  const open = Math.floor(sec / 300) * 300;
  const bars = [open - 900, open - 600, open - 300, open].map((time, i) => ({ time, open: 9000 + i, high: 9005 + i, low: 8995 + i, close: 9002 + i, volume: 10 }));
  const { call } = await connect({}, respondWith({ "/bars": bars }));
  const done = JSON.parse((await call("get_bars", { symbol: "MCX:CRUDEOIL", limit: 2 })).text);
  expect(done.bars).toHaveLength(2);
  expect(done.bars.some((b: any) => b.forming)).toBe(false);
  expect(done.bars[1].time).toBe(new Date((open - 300) * 1000).toISOString());
  const all = JSON.parse((await call("get_bars", { symbol: "MCX:CRUDEOIL", limit: 5, include_forming: true })).text);
  expect(all.bars).toHaveLength(4);
  expect(all.bars[3].forming).toBe(true);
});

test("the analysis tools read the API's computed views", async () => {
  const { call, calls } = await connect({}, respondWith({ "/analysis/technicals": { technicals: { rsi14: 55 } }, "/analysis/status": { instruments: [] }, "/analysis/recap": { headline: "Crude Oil is at 9100." }, "/canaries": { canaries: [] }, "/eia": { series: [] } }));
  expect(JSON.parse((await call("get_technicals", { symbol: "MCX:CRUDEOIL", timeframe: "1h" })).text).technicals.rsi14).toBe(55);
  expect(calls.at(-1)!.url).toBe("http://api.test/analysis/technicals?symbol=MCX%3ACRUDEOIL&tf=1h");
  await call("get_market_status");
  expect(calls.at(-1)!.url).toBe("http://api.test/analysis/status");
  expect(JSON.parse((await call("get_recap", { symbol: "NYMEX:CL" })).text).headline).toContain("Crude Oil");
  await call("get_source_checks");
  expect(calls.at(-1)!.url).toBe("http://api.test/canaries");
  await call("get_eia");
  expect(calls.at(-1)!.url).toBe("http://api.test/eia");
});

test("the option chain and chokepoint tools pass their choices through and keep results small", async () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, tankers: 40 + i }));
  const { call, calls } = await connect({}, respondWith({ "/options": { rows: [] }, "/chokepoints": { chokepoint: { id: "suez" }, summary: { flag: "normal" }, days, fetchedAt: 1 } }));
  await call("get_option_chain", { underlying: "CRUDEOIL", expiry: "2026-11-17", strikes_each_side: 12 });
  expect(calls.at(-1)!.url).toBe("http://api.test/options?underlying=CRUDEOIL&strikes=12&expiry=2026-11-17");
  const cp = JSON.parse((await call("get_chokepoints", { id: "suez", days_shown: 7 })).text);
  expect(cp.recentDays).toHaveLength(7);
  expect(cp.recentDays[6].tankers).toBe(69);
  expect(cp.summary.flag).toBe("normal");
});

test("bad arguments to the new read tools are refused before any request", async () => {
  const { call, calls } = await connect({}, respondWith());
  for (const [tool, args] of [
    ["get_news", { topic: "gold" }],
    ["get_news", { hours: 500 }],
    ["get_calendar", { days: 99 }],
    ["get_bars", { symbol: "MCX:CRUDEOIL", limit: 1000 }],
    ["get_bars", { symbol: "MCX:CRUDEOIL", timeframe: "2h" }],
    ["get_option_chain", { underlying: "GOLD" }],
    ["get_option_chain", { underlying: "CRUDEOIL", expiry: "17-11-2026" }],
    ["get_chokepoints", { id: "panama" }],
  ] as const) expect((await call(tool, args as never)).isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("a service that is down is reported, not hidden", async () => {
  const { call } = await connect({}, () => null);
  const r = await call("get_market_status");
  expect(r.isError).toBe(true);
  expect(r.text).toContain("not reachable");
});

test("place_paper_order passes the labels and the client order id through, and says when the answer is a repeat of an earlier order", async () => {
  const position = { id: "pp-1", symbol: "MCX:CRUDEOILM", side: "buy", lots: 1, entry: 9402, openedAt: 1_800_000_000_000, signalTime: Date.parse("2026-10-22T09:30:00+05:30"), tag: "usib-1", strategy: "USIB", fill: { price: 9402, quote: { price: 9400, time: 1_799_999_990_000 } } };
  let duplicate = false;
  const { call, calls } = await connect({ write: true }, () => ({ status: duplicate ? 200 : 201, body: { position, ...(duplicate ? { duplicate: true } : {}) } }));
  const args = { symbol: "MCX:CRUDEOILM", side: "buy", lots: 1, client_order_id: "usib-20261022-0930-L", tag: "usib-1", strategy: "USIB", signal_time: "2026-10-22T09:30:00+05:30", r_points: 40 };
  const first = JSON.parse((await call("place_paper_order", args)).text);
  expect(calls[0]!.body).toMatchObject(args);
  expect(first.duplicate).toBeUndefined();
  expect(first.filled.signalTimeIso).toBe("2026-10-22T04:00:00.000Z");
  expect(first.filled.fill.quote.timeIso).toBe(new Date(1_799_999_990_000).toISOString());
  duplicate = true;
  const again = JSON.parse((await call("place_paper_order", args)).text);
  expect(again.duplicate).toBe(true);
  expect(again.note).toContain("nothing new was filled");
});

test("place_paper_order refuses a malformed client order id, signal-less labels stay optional, before any request", async () => {
  const { call, calls } = await connect({ write: true });
  expect((await call("place_paper_order", { symbol: "MCX:CRUDEOILM", side: "buy", lots: 1, client_order_id: "has space" })).isError).toBe(true);
  expect((await call("place_paper_order", { symbol: "MCX:CRUDEOILM", side: "buy", lots: 1, r_points: -5 })).isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("list_paper_trades carries the labels, the R multiple and the fill records, with ISO times beside the epoch milliseconds", async () => {
  const trade = { id: "t1", symbol: "MCX:CRUDEOILM", side: "buy", lots: 1, entry: 9402, exit: 9478, openedAt: 1_800_000_000_000, closedAt: 1_800_000_600_000, net: 7520, tag: "usib-1", strategy: "USIB", signalTime: 1_799_999_900_000, rMultiple: 1.9, clientOrderId: "c1", entryFill: { price: 9402, slippageTicks: 1, quote: { price: 9400, source: "upstox", time: 1_799_999_990_000 } } };
  const { call } = await connect({}, () => ({ body: { state: { positions: [], trades: [trade] } } }));
  const [t] = JSON.parse((await call("list_paper_trades")).text);
  expect(t).toMatchObject({ tag: "usib-1", strategy: "USIB", rMultiple: 1.9, clientOrderId: "c1", closedAtIso: new Date(1_800_000_600_000).toISOString(), signalTimeIso: new Date(1_799_999_900_000).toISOString() });
  expect(t.entryFill.quote).toMatchObject({ source: "upstox", timeIso: new Date(1_799_999_990_000).toISOString() });
});

test("set_paper_stop_target passes the trailing flag and the reason, and returns the previous stop", async () => {
  const { call, calls } = await connect({ write: true }, () => ({ body: { position: { id: "pp-1", stop: 9450, openedAt: 1 }, previous: { stop: 9360 } } }));
  const r = JSON.parse((await call("set_paper_stop_target", { position_id: "pp-1", stop: 9450, only_tighten: true, reason: "USIB trail" })).text);
  expect(calls[0]).toMatchObject({ method: "PATCH", body: { stop: 9450, only_tighten: true, reason: "USIB trail" } });
  expect(r.previous).toEqual({ stop: 9360 });
});

test("an option order is sent as a buy of that option key, a waiting limit order is reported as waiting, and a bad key is refused before any request", async () => {
  const { call, calls, client } = await connect({ write: true }, () => ({ status: 201, body: { pending: { id: "w1", entry: 480 } } }));
  const r = await call("place_paper_option_order", { option_key: "MCX_FO|583810", lots: 1, entry: 480, stop: 400 });
  expect(JSON.parse(r.text).waiting.id).toBe("w1");
  expect(calls[0]).toMatchObject({ url: "http://stream.test/paper/accounts/main/orders", method: "POST", body: { option: { key: "MCX_FO|583810" }, side: "buy", lots: 1, entry: 480, stop: 400 } });
  expect(calls[0]!.headers["x-drishti-actor"]).toBe("mcp");
  const bad: any = await client.callTool({ name: "place_paper_option_order", arguments: { option_key: "MCX:CRUDEOIL", lots: 1 } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  expect(bad.isError).toBe(true);
  expect(calls).toHaveLength(1);
});

test("get_signals reads the log, passing the strategy and limit through", async () => {
  const { call, calls } = await connect({}, () => ({ body: [{ record: { key: "k", status: "signal", option: { label: "CRUDEOIL 9600 CE" } } }] }));
  const r = JSON.parse((await call("get_signals", { strategy: "usib", limit: 5 })).text);
  expect(r[0].record.option.label).toContain("CE");
  expect(calls.at(-1)!.url).toBe("http://api.test/signals?limit=5&strategy=usib");
  expect((await call("get_signals", { strategy: "other" })).isError).toBe(true);
});
