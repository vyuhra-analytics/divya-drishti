// Live smoke test against the running stack: `bun run smoke` (start `bun run dev` first). Hits every API route with a good request and a
// bad one, checks the stream's health and WebSocket, and the security defaults (foreign origins refused). Read-only: it creates and
// removes one never-firing server alert and sends nothing to Telegram.
const API = process.env.E2E_API ?? "http://127.0.0.1:3001";
const STREAM = process.env.E2E_STREAM ?? "http://127.0.0.1:3002";
const WEB_ORIGIN = "http://localhost:5173";

let pass = 0;
let fail = 0;
let skip = 0;
const results: string[] = [];

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    pass++;
    results.push(`PASS  ${name}${note ? `  — ${note}` : ""}`);
  } catch (e) {
    if ((e as Error).message.startsWith("SKIP:")) {
      skip++;
      results.push(`SKIP  ${name}  — ${(e as Error).message.slice(5).trim()}`);
    } else {
      fail++;
      results.push(`FAIL  ${name}  — ${(e as Error).message}`);
    }
  }
}
const need = (cond: unknown, msg: string): asserts cond => {
  if (!cond) throw new Error(msg);
};
const get = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers };
};
const ok = async (path: string) => {
  const r = await get(path);
  need(r.status === 200, `GET ${path} → HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);
  return r.json;
};
const bad = async (path: string, status = 400) => {
  const r = await get(path);
  need(r.status === status, `GET ${path} → HTTP ${r.status}, expected ${status}`);
};

// ---- API: good requests
await check("API health: postgres up", async () => {
  const h = await ok("/health");
  need(h.postgres === true, "postgres is down (bun run infra:up)");
  return `redis ${h.redis ? "up" : "off (optional)"}`;
});
await check("symbols", async () => need((await ok("/symbols")).length >= 6, "expected the 6 built-in instruments"));
await check("bars: crude 5m history is consistent", async () => {
  const bars = await ok("/bars?symbol=MCX:CRUDEOIL&tf=5m");
  need(bars.length > 100, `only ${bars.length} bars`);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    need(b.high >= Math.max(b.open, b.close, b.low) && b.low <= Math.min(b.open, b.close, b.high) && b.low > 0, `impossible bar at ${b.time}`);
    need(i === 0 || b.time > bars[i - 1].time, "bars not strictly ascending");
  }
  return `${bars.length} bars`;
});
await check("bars: stored (db) history and the rolls list", async () => {
  await ok("/bars?symbol=MCX:CRUDEOIL&tf=5m&source=db");
  need(Array.isArray(await ok("/rolls?symbol=MCX:CRUDEOIL")), "rolls is not a list");
});
await check("news: archive pages", async () => need(Array.isArray(await ok("/news?limit=5")), "not a list"));
await check("calendar: events with periods", async () => {
  const ev = await ok("/calendar?days=3");
  need(ev.length > 0 && ev.every((e: any) => e.id && e.title && Number.isFinite(e.at)), "bad events");
  return `${ev.length} events`;
});
await check("market sessions", async () => void (await ok("/market/sessions")));
await check("COT: WTI has 3 years of weekly rows", async () => {
  const c = await ok("/cot?market=wti&weeks=156");
  need(c.rows.length >= 100 && Number.isFinite(c.rows[c.rows.length - 1].managedMoney.net), "rows missing");
});
await check("chokepoints: Hormuz summary", async () => need((await ok("/chokepoints?id=hormuz")).summary?.asOf, "no summary"));
await check("curve: MCX crude has 2+ contracts", async () => need((await ok("/curve?symbol=MCX:CRUDEOIL")).points.length >= 2, "curve too short"));
await check("EIA: key set and series load", async () => {
  const r = await get("/eia");
  if (r.status === 503 && /EIA_API_KEY/.test(JSON.stringify(r.json))) throw new Error("SKIP: EIA_API_KEY not set");
  need(r.status === 200, `HTTP ${r.status}`);
  const loaded = r.json.series.filter((s: any) => s.latest).length;
  need(loaded >= 1, "no series loaded");
  return `${loaded}/10 series loaded`;
});
await check("canaries: every light source ok", async () => {
  const c = await ok("/canaries");
  need(c.canaries.length >= 12, `only ${c.canaries.length} checked (the first run starts ~4 s after boot)`);
  const notOk = c.canaries.filter((x: any) => !["ok", "skipped"].includes(x.status));
  need(notOk.length === 0, `failing: ${notOk.map((x: any) => `${x.id} ${x.status}`).join(", ")}`);
  need(c.sources.length >= 12, "registry missing");
});
await check("options chain (needs Upstox/TradingView)", async () => {
  const r = await get("/options?underlying=CRUDEOIL");
  if (r.status !== 200) throw new Error(`SKIP: HTTP ${r.status}`);
  need(r.json.rows?.length > 0 || r.json.strikes?.length > 0 || Object.keys(r.json).length > 2, "empty chain");
});
await check("options chain: strikes outside 4..40 or not a number is a 400", async () => {
  for (const s of ["3", "41", "abc", "1.5"]) {
    const r = await get(`/options?underlying=CRUDEOIL&strikes=${s}`);
    need(r.status === 400, `strikes=${s} → HTTP ${r.status}`);
  }
});
await check("costs check: bad input is a 400; a futures leg agrees with Upstox's own charge calculation", async () => {
  for (const q of ["symbol=MCX:CRUDEOIL&kind=swap&side=buy&price=9300", "symbol=MCX:CRUDEOIL&kind=future&side=hold&price=9300", "symbol=MCX:CRUDEOIL&kind=future&side=buy&price=abc", "symbol=NYMEX:CL&kind=future&side=buy&price=90", "key=NSE_EQ|1333&units=100&kind=option&side=buy&price=500"]) {
    const r = await get(`/costs/check?${q}`);
    need(r.status === 400, `${q} → HTTP ${r.status}`);
  }
  const r = await get("/costs/check?symbol=MCX:CRUDEOIL&kind=future&side=buy&price=9300&lots=1");
  if (r.status === 503) throw new Error(`SKIP: ${r.json?.message ?? "Upstox not reachable"}`);
  need(r.status === 200, `HTTP ${r.status}`);
  need(r.json.agree === true, `our table differs from Upstox by Rs ${r.json.diff} (Upstox ${r.json.upstox?.total}, ours ${r.json.ours?.total}): re-record with bun run fixtures:upstox-charges and fix costs.ts`);
});
await check("market status: the API reads the exchange's own MCX status and the stream carries it", async () => {
  const s = await ok("/market/status");
  need("mcx" in s, "no mcx field");
  if (s.mcx === null) throw new Error("SKIP: Upstox status not available (no token, or Upstox did not answer)");
  need(typeof s.mcx.state === "string" && s.mcx.state.length > 0 && typeof s.mcx.at === "number", "state or time missing");
  const h: any = await (await fetch(`${STREAM}/health`)).json();
  need("mcxStatus" in h, "the stream health does not carry the status");
  return `MCX ${s.mcx.state}`;
});
await check("option candles: the recorder's status answers, bad reads are a 400, and stored candles come back with open interest", async () => {
  for (const q of ["", "key=NSE_FO|1&from=2026-10-20&to=2026-10-22", "key=MCX_FO|582939&from=bad&to=2026-10-22", "key=MCX_FO|582939&from=2026-10-22&to=2026-10-20", "key=MCX_FO|582939&from=2026-01-01&to=2026-10-22"]) {
    const r = await get(`/option-candles?${q}`);
    need(r.status === 400, `${q} → HTTP ${r.status}`);
  }
  const st = await ok("/option-candles/status");
  need(typeof st.candles === "number" && typeof st.contracts === "number", "status shape");
  if (st.candles === 0) throw new Error("SKIP: nothing recorded yet (the recorder runs once after a session has closed)");
  const day = new Date((st.lastTime ?? Date.now() / 1000) * 1000 + 5.5 * 3600_000).toISOString().slice(0, 10);
  const chain = await ok("/options?underlying=CRUDEOIL&strikes=4");
  const atm = chain.rows.find((r: any) => r.strike === chain.atm);
  let withOi = 0;
  for (const key of [atm?.ce?.ukey, atm?.pe?.ukey].filter(Boolean)) {
    const rows = await ok(`/option-candles?key=${encodeURIComponent(key)}&from=${day}&to=${day}`);
    need(Array.isArray(rows), "not a list");
    if (rows.length) {
      need(rows.every((b: any) => b.high >= b.low && b.volume >= 0), "impossible candle stored");
      withOi += rows.filter((b: any) => typeof b.oi === "number").length;
    }
  }
  return `${st.candles} candles for ${st.contracts} contracts; ${withOi} at-the-money candles with open interest on ${day}`;
});
await check("Upstox account access: the API says whether your account can be read, and never returns anything from the profile", async () => {
  const a = await ok("/auth/upstox/account");
  need(["ok", "static_ip", "token", "no_token", "unavailable"].includes(a.access), `unknown state ${a.access}`);
  need(typeof a.hint === "string" && a.hint.length > 10, "no hint");
  need(Object.keys(a).sort().join() === "access,hint", `extra fields: ${Object.keys(a)}`);
  return a.access;
});
await check("server alerts: channels, create, list, delete (never fires, sends nothing)", async () => {
  const ch = await ok("/alerts/channels");
  need("telegram" in ch && "webhook" in ch, "channel status missing");
  const made = await get("/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: 1_000_000 }) });
  need(made.status === 201 || made.status === 200, `create → HTTP ${made.status}`);
  const id = made.json.id;
  try {
    need((await ok("/alerts")).some((a: any) => a.id === id), "not listed");
  } finally {
    await get(`/alerts/${id}`, { method: "DELETE" });
  }
  need(!(await ok("/alerts")).some((a: any) => a.id === id), "not deleted");
  return `Telegram ${ch.telegramLinked ? "linked" : ch.telegram ? "bot set" : "not set"}`;
});

// ---- API: bad requests are refused with 400, never a 500
for (const [name, path] of [
  ["unknown symbol", "/bars?symbol=DOGE"],
  ["unknown timeframe", "/bars?symbol=MCX:CRUDEOIL&tf=9x"],
  ["unknown COT market", "/cot?market=nope"],
  ["COT weeks out of range", "/cot?market=wti&weeks=1"],
  ["unknown chokepoint", "/chokepoints?id=x"],
  ["unknown curve symbol", "/curve?symbol=x"],
  ["calendar days out of range", "/calendar?days=999"],
] as const) {
  await check(`refuses: ${name}`, () => bad(path));
}
await check("refuses: a malformed server alert", async () => {
  const r = await get("/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "price", symbol: "DOGE", op: "above", value: 1 }) });
  need(r.status === 400, `HTTP ${r.status}`);
});
await check("refuses: a foreign website reading the API (CORS)", async () => {
  const r = await get("/symbols", { headers: { Origin: "https://evil.example" } });
  need(!r.headers.get("access-control-allow-origin"), "the API allowed a foreign origin");
  const mine = await get("/symbols", { headers: { Origin: WEB_ORIGIN } });
  need(mine.headers.get("access-control-allow-origin") === WEB_ORIGIN, "our own origin is not allowed");
});

// ---- stream
await check("stream health: providers live, feeds agree, nothing rejected", async () => {
  const h: any = await (await fetch(`${STREAM}/health`)).json();
  for (const name of ["upstox", "tradingview", "yahoo"]) need(h.providers[name]?.ok > 0, `${name} has never succeeded`);
  need(Object.keys(h.prices ?? {}).length >= 7, "per-source prices missing");
  return `${h.rejected?.count ?? 0} quotes rejected`;
});
await check("stream: front months known", async () => need(Object.keys(await (await fetch(`${STREAM}/fronts`)).json()).length >= 4, "expected the 4 built-in MCX front months"));
await check("USD/INR: a plausible live rate from the stream, history from the API, never a paper-trading symbol", async () => {
  const p = (await (await fetch(`${STREAM}/health`)).json()).prices["FX:USDINR"];
  need(p && Object.keys(p).length >= 1, "no USD/INR price from any feed");
  const rate = Object.values(p as Record<string, { price: number }>)[0]!.price;
  need(rate > 40 && rate < 200, `implausible rate ${rate}`);
  need((await ok("/bars?symbol=FX:USDINR&tf=1d")).length > 30, "no daily history");
  const order = await fetch(`${STREAM}/paper/accounts/main/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: "FX:USDINR", side: "buy", lots: 1 }) });
  need(order.status === 400, `a paper order on USD/INR got HTTP ${order.status}`);
});
await check("stream WebSocket: a live quote and a heartbeat arrive", async () => {
  const got = await new Promise<{ quote?: any; hb?: boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3002/ws`, { headers: { Origin: WEB_ORIGIN } } as any);
    const seen: { quote?: any; hb?: boolean } = {};
    const t = setTimeout(() => (ws.close(), resolve(seen)), 8000);
    ws.onopen = () => ws.send(JSON.stringify({ subscribe: ["MCX:CRUDEOIL", "alerts"] }));
    ws.onerror = () => reject(new Error("WebSocket error"));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.symbol) seen.quote = m;
      if (m.type === "hb") seen.hb = true;
      if (seen.quote && seen.hb) (clearTimeout(t), ws.close(), resolve(seen));
    };
  });
  need(got.hb, "no heartbeat");
  need(got.quote && got.quote.price > 0 && ["upstox", "tradingview"].includes(got.quote.source), "no valid quote");
  return `${got.quote.source} ${got.quote.price}`;
});
await check("live option feed: a watched contract streams its premium, depth and greeks; a malformed or unknown key is ignored", async () => {
  const chain = await ok("/options?underlying=CRUDEOIL&strikes=4");
  const atm = chain.rows.find((r: any) => r.strike === chain.atm) ?? chain.rows[Math.floor(chain.rows.length / 2)];
  const good: string[] = [atm.ce?.ukey, atm.pe?.ukey].filter(Boolean);
  need(good.length === 2, "the chain carries no Upstox keys");
  const bad = ["NSE_FO|12345", "MCX_FO|1", "x; drop table", "MCX_FO|99999999"];
  const got = await new Promise<Record<string, any>>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3002/ws`, { headers: { Origin: WEB_ORIGIN } } as any);
    const seen: Record<string, any> = {};
    const t = setTimeout(() => (ws.close(), resolve(seen)), 9000);
    ws.onopen = () => (ws.send(JSON.stringify({ subscribe: ["options"] })), ws.send(JSON.stringify({ watch: [...good, ...bad] })));
    ws.onerror = () => reject(new Error("WebSocket error"));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "opt") {
        seen[m.q.key] = m.q;
        if (good.every((k) => seen[k])) (clearTimeout(t), ws.close(), resolve(seen));
      }
    };
  });
  if (!good.every((k) => got[k])) {
    const st = (await ok("/market/status")).mcx?.state;
    if (st && st !== "NORMAL_OPEN") throw new Error(`SKIP: MCX is ${st}, no ticks to see`);
    throw new Error(`no tick for ${good.filter((k) => !got[k]).join(", ")} within 9 s`);
  }
  need(Object.keys(got).every((k) => good.includes(k)), `a key nobody should get arrived: ${Object.keys(got).filter((k) => !good.includes(k))}`);
  const q = got[good[0]];
  need(q.price > 0 && q.bid > 0 && q.ask > 0 && q.depth?.length >= 1 && typeof q.delta === "number" && q.iv > 0, "premium, depth or greeks missing");
  const h: any = await (await fetch(`${STREAM}/health`)).json();
  need(h.options && h.options.messages > 0, "the stream health does not count option messages");
  return `${good.length} contracts, premium ${q.price}, bid ${q.bid} / ask ${q.ask}, delta ${q.delta.toFixed(2)}; lag p95 ${h.options.lagP95Ms ?? "n/a"} ms over ${h.options.lagSamples} new trades`;
});
await check("refuses: a foreign website opening the WebSocket", async () => {
  const code = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:3002/ws`, { headers: { Origin: "https://evil.example" } } as any);
    ws.onopen = () => (ws.close(), resolve("connected"));
    ws.onerror = () => resolve("refused");
    ws.onclose = () => resolve("refused");
    setTimeout(() => resolve("timeout"), 5000);
  });
  need(code === "refused", `a foreign origin ${code}`);
});
await check("ignores: unknown and internal topic names (no data, connection survives)", async () => {
  const seen = await new Promise<{ quotes: number; open: boolean }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:3002/ws`, { headers: { Origin: WEB_ORIGIN } } as any);
    let quotes = 0;
    ws.onopen = () => ws.send(JSON.stringify({ subscribe: ["../etc/passwd", "quotes:MCX:CRUDEOIL", "hb2", 42, { x: 1 }] })); // the internal topic name is not a valid request either
    ws.onmessage = (e) => {
      if (JSON.parse(String(e.data)).symbol) quotes++;
    };
    setTimeout(() => {
      const open = ws.readyState === 1;
      ws.close();
      resolve({ quotes, open });
    }, 4000);
  });
  need(seen.quotes === 0, `${seen.quotes} quotes arrived for topics that should not exist`);
  need(seen.open, "the connection was dropped instead of the topics being ignored");
});

// ---- paper trading API (simulated): a throwaway account, so nothing of yours is touched
const paper = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${STREAM}/paper${path}`, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};
await check("paper API: account state, agent caps, refusals, cleanup (throwaway account)", async () => {
  const made = await paper("/accounts", "POST", { id: "smoke", capital: 100000, slippage: 1 });
  if (made.status === 503 || made.status === 500) throw new Error("SKIP: paper tables missing (bun run db:migrate)");
  need(made.status === 200 || made.status === 409, `create account → HTTP ${made.status}`);
  try {
    const st = await paper("/accounts/smoke");
    need(st.status === 200 && st.json.state.limits.maxLots === 100, "state missing the UI limits");
    const agentState = await paper("/accounts/smoke", "GET", undefined, { "x-drishti-actor": "mcp" });
    need(agentState.json.state.limits.maxLots === 2, "the agent does not get its tighter caps");
    for (const [name, order, status] of [
      ["bad symbol", { symbol: "DOGE", side: "buy", lots: 1 }, 400],
      ["NYMEX (no cost model)", { symbol: "NYMEX:CL", side: "buy", lots: 1 }, 400],
      ["fractional lots", { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1.5 }, 400],
    ] as const) {
      const r = await paper("/accounts/smoke/orders", "POST", order);
      need(r.status === status, `${name} → HTTP ${r.status}, expected ${status}`);
    }
    const big = await paper("/accounts/smoke/orders", "POST", { symbol: "MCX:CRUDEOIL", side: "buy", lots: 3 }, { "x-drishti-actor": "mcp" });
    need(big.status === 422 && /at most 2 lots/.test(big.json.error), `agent 3 lots → HTTP ${big.status} ${big.json.error}`);
    need((await paper("/accounts/nope")).status === 404, "unknown account is not a 404");
    need((await paper("/accounts/main", "DELETE")).status === 409, "the main account can be deleted");
  } finally {
    await paper("/accounts/smoke", "DELETE");
  }
  need((await paper("/accounts/smoke")).status === 404, "the throwaway account was not removed");
});
await check("refuses: a foreign website using the paper API", async () => {
  const r = await fetch(`${STREAM}/paper/accounts`, { headers: { Origin: "https://evil.example" } });
  need(r.status === 403, `a foreign origin got HTTP ${r.status}`);
  const mine = await fetch(`${STREAM}/paper/accounts`, { headers: { Origin: WEB_ORIGIN } });
  need(mine.status === 200 && mine.headers.get("access-control-allow-origin") === WEB_ORIGIN, "our own origin is not allowed");
});

await check("instruments API: list, bad input is a 400, built-ins cannot be removed, a foreign website is refused (nothing added)", async () => {
  const list = await (await fetch(`${STREAM}/instruments`, { headers: { Origin: WEB_ORIGIN } })).json();
  need(list.instruments.length >= 6, "the six built-in instruments are missing");
  const post = (body: unknown, origin = WEB_ORIGIN) => fetch(`${STREAM}/instruments`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const bad of [{}, { exchange: "NSE", root: "X", name: "Xx", decimals: 2, lot: "1 kg", topic: "crude" }, { exchange: "MCX", root: "CRUDEOIL", name: "Dupe", decimals: 0, lot: "1 bbl", topic: "crude" }]) {
    const r = await post(bad);
    need(r.status === 400, `bad body got HTTP ${r.status}`);
  }
  need((await fetch(`${STREAM}/instruments/${encodeURIComponent("MCX:CRUDEOIL")}`, { method: "DELETE", headers: { Origin: WEB_ORIGIN } })).status === 403, "a built-in could be removed");
  const foreign = await post({ exchange: "NYMEX", root: "RB", name: "RBOB", decimals: 4, lot: "42000 gal", topic: "crude" }, "https://evil.example");
  need(foreign.status === 403, `a foreign origin got HTTP ${foreign.status}`);
  const after = await (await fetch(`${STREAM}/instruments`)).json();
  need(after.instruments.length === list.instruments.length, "the catalogue changed");
});

await check("analysis routes: bad requests are a 400, the status covers every instrument and the stream state", async () => {
  need((await get("/analysis/technicals?symbol=MCX:GOLD")).status === 400, "unknown symbol was not a 400");
  need((await get("/analysis/technicals?symbol=MCX:CRUDEOIL&tf=2h")).status === 400, "unknown timeframe was not a 400");
  need((await get("/analysis/recap?symbol=FX:USDINR")).status === 400, "a recap for a currency was not a 400");
  const st = await ok("/analysis/status");
  need(st.instruments.length >= 7 && st.sessions.MCX && st.sessions.FX, "status is incomplete");
  need(!st.warning, "the status says the stream is unreachable");
});
await check("agent briefings: bad requests are refused, a foreign website cannot submit or announce (nothing stored)", async () => {
  need((await get("/briefing/context?symbol=MCX:GOLD")).status === 400, "unknown symbol was not a 400");
  need((await get("/briefing/context?symbol=MCX:CRUDEOIL&tf=2h")).status === 400, "unknown timeframe was not a 400");
  const post = (body: string, type: string) => get("/briefing/submit", { method: "POST", headers: { "Content-Type": type, Origin: "https://evil.example" }, body });
  const valid = JSON.stringify({ symbol: "MCX:CRUDEOIL", context_id: "ctx-x", bias: "bullish", confidence: "low", summary: "x", bull: [], bear: [] });
  need((await post("{}", "application/json")).status === 400, "an empty submission was not a 400");
  need((await post(valid, "application/json")).status !== 201, "a foreign website could submit a briefing");
  need((await post(valid, "text/plain")).status === 400, "a text/plain (no-preflight) submission was accepted");
  const unknown = await get("/briefing/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: valid });
  need(unknown.status === 410, `an unknown context was HTTP ${unknown.status}, not 410`);
  const announce = (origin?: string, body: unknown = { id: "x", symbol: "MCX:CRUDEOIL", bias: "bullish", verified: 1, total: 1, wrong: 0 }) =>
    fetch(`${STREAM}/briefings/announce`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  need((await announce("https://evil.example")).status === 403, "a foreign origin could announce");
  need((await announce(undefined, { id: "x", symbol: "MCX:GOLD", bias: "bullish", verified: 1, total: 1, wrong: 0 })).status === 400, "a bad announcement was accepted");
});

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
