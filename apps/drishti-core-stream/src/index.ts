import { Elysia } from "elysia";
import { RedisClient, SQL } from "bun";
import {
  agreement,
  DEFAULT_LIMITS,
  freshness,
  mcxSession,
  nymexSession,
  fxSession,
  PaperEngine,
  UPSTOX_MCX_RATES,
  type DayOverride,
  type MarketStatus,
  optionLagMs,
  withStatus,
  allowedOrigins,
  changedFronts,
  REDIS_OPTIONS,
  INSTRUMENTS,
  isAllowedOrigin,
  RateLimiter,
  SYMBOLS,
  instrument,
  parseCustomInstrument,
  setCustomInstruments,
  pickSource,
  prioritize,
  quoteProblem,
  quoteToTick,
  tvContract,
  tvTickerFor,
  type ClientMessage,
  type Instrument,
  type Quote,
  type SourcePrices,
  type Source,
  type Tick,
} from "@drishti/shared";
import { loadFronts, loadOptionKeys, tvCloses, upstoxHasFuture, type Fronts } from "./contracts";
import { LagWindow, OptionWatch } from "./optionWatch";
import { formOf, instrumentRoutes } from "./instrumentRoutes";
import { newStats, type ProviderStats } from "./providers/provider";
import { startServerAlerts } from "./serverAlerts";
import { PgPaperStore } from "./paperStore";
import { paperRoutes } from "./paperRoutes";
import { startTradingView } from "./providers/tradingview";
import { startYahoo } from "./providers/yahoo";
import { demoStats, startDemo } from "./providers/demo";
import { startUpstox, type UpstoxTarget } from "./providers/upstox/upstox";
import { startFeedRecorder } from "./feedRecorder";
import { startMinuteLog, startUpstoxCapture } from "./upstoxCapture";
import { archiveStats, currentNews, newsStats, startNews } from "./news";

const PORT = Number(process.env.STREAM_PORT ?? 3002);
// Localhost only by default (see drishti-core-api main.ts); HOST=0.0.0.0 to expose deliberately.
const HOST = process.env.HOST ?? "127.0.0.1";
const ORIGINS = allowedOrigins(process.env.WEB_ORIGINS);
const EXTRA_TOPICS = new Set<string>(["news", "alerts", "paper", "briefing", "options"]);
const isTopic = (t: string) => EXTRA_TOPICS.has(t) || SYMBOLS.includes(t); // SYMBOLS grows when an instrument is added in Settings
const HEARTBEAT_MS = 15_000; // clients treat ~3 missed heartbeats as a dead socket and reconnect
const wsLimiter = new RateLimiter(30, 10_000); // subscribe/unsubscribe messages per connection
const DEMO = process.env.FEED === "demo";
const STALE_MS = 15_000; // a source silent this long hands over to the next one
const FLUSH_MS = 1000;
const FRONTS_REFRESH_MS = 3600_000; // hourly: picks up the volume roll to the next month during the session

const sql = new SQL(process.env.DATABASE_URL!, { connectionTimeout: 2 });
const redis = new RedisClient(process.env.REDIS_URL, REDIS_OPTIONS);

const stats: Partial<Record<Source, ProviderStats>> = DEMO ? { demo: demoStats } : { upstox: newStats(), tradingview: newStats(), yahoo: newStats() };

// ---- routing: every provider quote goes through here; only the active source per symbol is published ----
const lastSeen = new Map<string, Partial<Record<Source, number>>>();
const latest = new Map<string, Quote>();
// Which source MCX quotes prefer (the others stay as fallback). Set from Settings → Data feeds (POST /primary),
// kept in Redis so a restart remembers it; MCX_PRIMARY in .env is the default.
const PRIMARY_CHOICES: Source[] = ["upstox", "tradingview"];
let mcxPrimary: Source | undefined = PRIMARY_CHOICES.find((s) => s === process.env.MCX_PRIMARY);
redis.get("primary:mcx").then((v) => { const s = PRIMARY_CHOICES.find((c) => c === v); if (s) mcxPrimary = s; }).catch(() => {});
const active = new Map<string, Source>();
// copies the Upstox feed (futures quotes and the option contracts near the money) into Postgres: it is not available after the session
const feedRecorder =
  process.env.FEED === "demo" || process.env.FEED_RECORDER === "off"
    ? undefined
    : startFeedRecorder(new SQL(process.env.DATABASE_URL!, { connectionTimeout: 2 }), (underlying) => {
        const inst = INSTRUMENTS.find((i) => i.upstox === underlying);
        return inst ? latest.get(inst.symbol)?.price : undefined;
      });

/**
 * Heartbeat + freshness: when each symbol's active source was last heard from (any poll/feed message, even with
 * no price change). Clients can't infer this themselves: unchanged prices aren't re-sent.
 */
const heartbeat = () => {
  const seen: Record<string, number> = {};
  for (const [symbol, src] of active) {
    const at = lastSeen.get(symbol)?.[src];
    if (at) seen[symbol] = at;
  }
  return JSON.stringify({ type: "hb", t: Date.now(), seen, mcxStatus: mcxStatus ?? null });
};
let buffer: Tick[] = [];

// ---- live option quotes: clients name the contracts they show (`watch`), the Upstox feed carries them, and every tick is published on topic "options"
let optionKeys = new Set<string>(); // every unexpired option on our MCX underlyings, from the public master (empty until it loads: any well-formed key is accepted then)
const optionWatch = new OptionWatch((k) => optionKeys.size === 0 || optionKeys.has(k));
const optionLag = new LagWindow();
const lastTrade = new Map<string, number>(); // per contract: the exchange trade time of the previous message, so lag is measured only on a NEW trade (a quiet strike repeats its old trade time)
const optionStats = { messages: 0, lastAt: null as number | null };
const refreshOptionKeys = () =>
  loadOptionKeys()
    .then((keys) => void (optionKeys = keys))
    .catch((err) => console.warn("option contract list failed:", (err as Error).message));
setInterval(() => optionWatch.sweep(), 5_000);

const lastPrice = new Map<string, SourcePrices>();
const DRIFT_PCT = Number(process.env.DRIFT_FLAG_PCT) > 0 ? Number(process.env.DRIFT_FLAG_PCT) : undefined; // percent; default in shared drift.ts
const rejected = { count: 0, last: undefined as undefined | { symbol: string; source: string; reason: string; at: number } };

function accept(q: Quote) {
  const inst = instrument(q.symbol);
  if (!inst) return;
  // never publish or store a quote we know is impossible (zero or negative price, high under low...): count it, and don't treat it as "heard from"
  const bad = quoteProblem(q);
  if (bad) {
    rejected.count++;
    if (!rejected.last || Date.now() - rejected.last.at > 60_000) console.warn(`rejected ${q.source} quote for ${q.symbol}: ${bad}`);
    rejected.last = { symbol: q.symbol, source: q.source, reason: bad, at: Date.now() };
    return;
  }
  feedRecorder?.onQuote(q); // the Upstox feed is copied whether or not it is the source shown (FEED_RECORDER=off disables)
  const now = Date.now();
  // every source's latest price, active or not: the data-quality console compares them (shared `agreement`)
  const bySource = lastPrice.get(q.symbol) ?? {};
  bySource[q.source] = { price: q.price, at: now, delayedBy: q.delayedBy };
  lastPrice.set(q.symbol, bySource);
  const seen = lastSeen.get(q.symbol) ?? {};
  seen[q.source] = now;
  lastSeen.set(q.symbol, seen);
  const winner = pickSource(seen, DEMO ? ["demo"] : prioritize(inst.sources, inst.exchange === "MCX" ? mcxPrimary : undefined), now, STALE_MS);
  if (winner) active.set(q.symbol, winner);
  if (q.source !== winner) return;

  // provenance: when another live source disagrees with the one we show by more than the drift threshold, say so on the quote itself
  const ag = agreement(q.symbol, bySource, now, DRIFT_PCT);
  if (ag.drifting && ag.gap) q = { ...q, drift: { between: ag.gap.between, pct: Number(ag.gap.pct.toFixed(3)), ticks: ag.gap.ticks } };

  const prev = latest.get(q.symbol);
  // republish only when something shown changed (trade, depth, OI or whether the feeds disagree); heartbeat re-sends stay quiet
  const same = (k: keyof Quote) => prev?.[k] === q[k];
  if (prev && Boolean(prev.drift) === Boolean(q.drift) && (["source", "price", "volume", "time", "bid", "ask", "bidQty", "askQty", "oi"] as const).every(same)) return;
  latest.set(q.symbol, q);
  // volume counts differ between sources, so only diff volumes within one source
  const tick = quoteToTick(prev?.source === q.source ? prev : undefined, q);
  if (tick) buffer.push(tick);

  const json = JSON.stringify(q);
  app.server?.publish(`quotes:${q.symbol}`, json);
  // ponytail: fire-and-forget Redis writes; add backpressure/metrics if they ever fall behind
  redis.send("PUBLISH", [`quotes:${q.symbol}`, json]).catch(() => {});
  redis.set(`quote:${q.symbol}`, json).catch(() => {});
  serverAlerts?.onQuotes();
  void paperEngine?.onQuotes().catch((e) => console.warn("paper engine:", (e as Error).message));
}

let paperEngine: PaperEngine | undefined;

// server-side alerts (R22): evaluated here on every live quote, headline and a timer; see serverAlerts.ts
let serverAlerts: ReturnType<typeof startServerAlerts> | undefined;

// ---- front-month contracts (MCX) ----
let fronts: Fronts = new Map();
// drishti-core-api reads the instrument keys for Upstox history from Redis. Re-published every minute: a write
// made while Redis is (re)connecting is dropped (no offline queue), and Redis may restart without persistence.
const publishFronts = () => {
  if (fronts.size) redis.set("fronts", JSON.stringify(Object.fromEntries(fronts))).catch(() => {});
};
setInterval(publishFronts, 60_000);
/** When the traded MCX contract changes, store the price gap between old and new so stored candles can be back-adjusted (shared `continuous.ts`). */
async function recordRolls(before: Fronts, after: Fronts) {
  const keyOf = (f: Fronts) => new Map([...f].map(([u, r]) => [u, r.trading_symbol]));
  for (const c of changedFronts(keyOf(before), keyOf(after))) {
    const inst = INSTRUMENTS.find((i) => i.upstox === c.underlying);
    const [oldRow, newRow] = [before.get(c.underlying), after.get(c.underlying)];
    if (!inst || !oldRow?.expiry || !newRow?.expiry) continue;
    const [oldCode, newCode] = [tvContract(inst.tv, oldRow.expiry), tvContract(inst.tv, newRow.expiry)];
    const closes = await tvCloses([oldCode, newCode]);
    const [p0, p1] = [closes.get(oldCode), closes.get(newCode)];
    if (p0 === undefined || p1 === undefined) continue; // no price for one side: skip rather than record a guess
    await sql`INSERT INTO rolls (symbol, at, from_contract, to_contract, gap) VALUES (${inst.symbol}, now(), ${c.from}, ${c.to}, ${p1 - p0}) ON CONFLICT DO NOTHING`;
    console.log(`roll ${inst.symbol}: ${c.from} → ${c.to}, gap ${(p1 - p0).toFixed(2)}`);
  }
}
async function refreshFronts() {
  try {
    const before = fronts;
    fronts = await loadFronts();
    publishFronts();
    recordRolls(before, fronts).catch((err) => console.warn("roll record failed:", (err as Error).message));
    console.log("MCX front months:", [...fronts.values()].map((r) => r.trading_symbol).join(", "));
  } catch (err) {
    console.error("instrument master failed, TradingView falls back to 1! codes:", (err as Error).message);
  }
}

/** TradingView tickers to poll: dated MCX codes from the front months, `1!` for NYMEX (or if the master is unavailable). */
function tvTargets() {
  const out = new Map<string, { inst: Instrument; contract?: string }>();
  for (const inst of INSTRUMENTS) {
    const front = inst.upstox ? fronts.get(inst.upstox) : undefined;
    const ticker = tvTickerFor(inst, front?.expiry, process.env.TV_MCX_CONTINUOUS === "1");
    if (!ticker) continue; // MCX without a known front month: the continuous code would show the wrong contract, so no TradingView price rather than a misleading one
    out.set(ticker, { inst, contract: front?.trading_symbol });
  }
  return out;
}

/** Upstox instrument_key → our instrument, from the front months. */
function upstoxTargets() {
  const out = new Map<string, UpstoxTarget>();
  for (const inst of INSTRUMENTS) {
    const front = inst.upstox ? fronts.get(inst.upstox) : undefined;
    if (front) out.set(front.instrument_key, { inst, contract: front.trading_symbol });
  }
  return out;
}

// ---- server-side paper trading (simulated): the engine lives here because the live quotes do ----
let mcxDay: DayOverride | undefined; // today's official MCX window from Upstox, via the API (holidays, special sessions); the weekday rule until it arrives
const refreshMcxDay = () =>
  fetch(`http://127.0.0.1:${process.env.API_PORT ?? 3001}/market/sessions`, { signal: AbortSignal.timeout(5000) })
    .then(async (r) => void (mcxDay = r.ok ? ((await r.json()) as { mcx: DayOverride | null }).mcx ?? undefined : undefined))
    .catch(() => undefined);
void refreshMcxDay();
setInterval(() => void refreshMcxDay(), 30 * 60_000);
let mcxStatus: MarketStatus | undefined; // the exchange's own status from Upstox, via the API (halts, early closes); the rules decide when it is unknown or old
const refreshMcxStatus = () =>
  fetch(`http://127.0.0.1:${process.env.API_PORT ?? 3001}/market/status`, { signal: AbortSignal.timeout(5000) })
    .then(async (r) => void (mcxStatus = r.ok ? ((await r.json()) as { mcx: MarketStatus | null }).mcx ?? undefined : undefined))
    .then(() => upstoxCapture?.logStatus("MCX", mcxStatus))
    .catch(() => void (mcxStatus = undefined));
void refreshMcxStatus();
setInterval(() => void refreshMcxStatus(), 30_000);
/** Exchange open and the active source heard from in the last minute: the same rule the browser uses (`useFreshness`). */
const symbolLive = (symbol: string) => {
  const exchange = instrument(symbol)?.exchange;
  const now = Date.now();
  const open = exchange === "MCX" ? withStatus(mcxSession(now, mcxDay), mcxStatus, now).open : exchange === "NYMEX" ? nymexSession(now).open : exchange === "FX" ? fxSession(now).open : true;
  const src = active.get(symbol);
  return freshness(open, src ? lastSeen.get(symbol)?.[src] : undefined, now) === "live";
};
// the rest of what Upstox tells us about our contracts: chain snapshots, the daily contract list, session times, status changes (FEED_RECORDER=off disables)
const upstoxCapture =
  DEMO || process.env.FEED_RECORDER === "off"
    ? undefined
    : startUpstoxCapture(sql, {
        token: async () => (await redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim() || null,
        mcxOpen: () => withStatus(mcxSession(Date.now(), mcxDay), mcxStatus, Date.now()).open,
      });
if (!DEMO && process.env.FEED_RECORDER !== "off")
  startMinuteLog(sql, () => ({ msgs: stats.upstox?.ok ?? 0, rows: (feedRecorder?.stats.rows ?? 0), failed: feedRecorder?.stats.failedInserts ?? 0 }));
const paperStore = new PgPaperStore(sql);
const envInt = (name: string, d: number) => (Number(process.env[name]) > 0 ? Math.floor(Number(process.env[name])) : d);
paperEngine = new PaperEngine({
  store: paperStore,
  quote: (symbol) => latest.get(symbol),
  live: symbolLive,
  rates: () => paperStore.rates().catch(() => UPSTOX_MCX_RATES),
  now: Date.now,
  newId: () => `pp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  publish: (e) => void app.server?.publish("paper", JSON.stringify({ type: "paper", ...e, at: Date.now() })),
  limits: {
    ui: DEFAULT_LIMITS.ui,
    mcp: { maxLots: envInt("PAPER_MCP_MAX_LOTS", DEFAULT_LIMITS.mcp.maxLots), maxOpenPositions: envInt("PAPER_MCP_MAX_POSITIONS", DEFAULT_LIMITS.mcp.maxOpenPositions), maxOrdersPerDay: envInt("PAPER_MCP_MAX_ORDERS_PER_DAY", DEFAULT_LIMITS.mcp.maxOrdersPerDay) },
  },
});
const loadPaper = () => paperEngine!.refresh().catch((e) => console.warn(`paper trading idle (is the database migrated? bun run db:migrate): ${(e as Error).message}`));
void loadPaper();
setInterval(() => void loadPaper(), 15_000);
const paperLimiter = new RateLimiter(240, 60_000); // requests a minute to /paper: the panel polls and the MCP server calls through here

// ---- instruments the user added (Settings → Instruments): Postgres is the source of truth, the catalogue in shared is changed in place ----
const instrumentLimiter = new RateLimiter(60, 60_000);
async function loadCustomInstruments() {
  const rows = (await sql`SELECT data FROM custom_instruments ORDER BY created_at`) as { data: unknown }[];
  const accepted: Instrument[] = [];
  const builtins = INSTRUMENTS.filter((i) => !i.custom);
  for (const row of rows) {
    const r = parseCustomInstrument(row.data, [...builtins, ...accepted]); // validated again on every load, so a bad row in the table cannot reach the feeds
    if ("instrument" in r) accepted.push(r.instrument);
    else console.warn(`ignored stored instrument: ${r.error}`);
  }
  const before = new Set(SYMBOLS);
  setCustomInstruments(accepted);
  for (const s of before) {
    if (SYMBOLS.includes(s)) continue; // removed: forget its prices so nothing stale is served
    for (const m of [latest, active, lastSeen, lastPrice] as Map<string, unknown>[]) m.delete(s);
  }
  if (!DEMO && SYMBOLS.some((s) => !before.has(s))) await refreshFronts(); // an added MCX future gets its front month (and so its Upstox and TradingView codes) now, not at the next hourly refresh
}
void loadCustomInstruments().catch((e) => console.warn(`no added instruments loaded (is the database migrated? bun run db:migrate): ${(e as Error).message}`));
setInterval(() => void loadCustomInstruments().catch(() => undefined), 60_000);

const app = new Elysia()
  .use(
    instrumentRoutes({
      origins: ORIGINS,
      limiter: instrumentLimiter,
      upstoxHasFuture: (u) => upstoxHasFuture(u).catch(() => true), // master file unreachable: don't block the add, the next refresh will tell
      hasOpenPosition: async (symbol) => ((await sql`SELECT 1 FROM paper_positions WHERE data->>'symbol' = ${symbol} LIMIT 1`) as unknown[]).length > 0,
      save: async (i) => void (await sql`INSERT INTO custom_instruments (symbol, data) VALUES (${i.symbol}, ${JSON.stringify(formOf(i))}::text::jsonb)`),
      remove: async (symbol) => void (await sql`DELETE FROM custom_instruments WHERE symbol = ${symbol}`),
      changed: loadCustomInstruments,
    }),
  )
  // the API tells us a briefing from an agent was stored, so open browsers show a notice (localhost / allowed origins only, tiny fixed shape)
  .post("/briefings/announce", ({ request, body, set }) => {
    if (!isAllowedOrigin(request.headers.get("origin"), ORIGINS)) {
      set.status = 403;
      return { error: "forbidden origin" };
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000 ? v : undefined);
    if (typeof b.id !== "string" || b.id.length > 40 || typeof b.symbol !== "string" || !SYMBOLS.includes(b.symbol) || !["bullish", "bearish", "neutral"].includes(b.bias as string) || n(b.verified) === undefined || n(b.total) === undefined || n(b.wrong) === undefined) {
      set.status = 400;
      return { error: "bad announcement" };
    }
    app.server?.publish("briefing", JSON.stringify({ type: "briefing", id: b.id, symbol: b.symbol, bias: b.bias, verified: b.verified, total: b.total, wrong: b.wrong, at: Date.now() }));
    return { ok: true };
  })
  .use(paperRoutes({ engine: paperEngine, store: paperStore, quote: (s) => latest.get(s), origins: ORIGINS, limiter: paperLimiter, publish: (e) => void app.server?.publish("paper", JSON.stringify({ type: "paper", ...e, at: Date.now() })) }))
  // traded MCX contracts (instrument keys) for drishti-core-api's Upstox history when Redis isn't available
  .get("/fronts", () => Object.fromEntries(fronts))
  // preflight for the JSON POST below
  .options("/primary", ({ request, set }) => {
    const origin = request.headers.get("origin");
    if (origin && isAllowedOrigin(origin, ORIGINS)) {
      set.headers["access-control-allow-origin"] = origin;
      set.headers["access-control-allow-methods"] = "POST";
      set.headers["access-control-allow-headers"] = "content-type";
    }
    set.status = 204;
  })
  // body {source: "upstox" | "tradingview" | "auto"}; browser origins on the allow-list only
  .post("/primary", async ({ request, set, body }) => {
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, ORIGINS)) {
      set.status = 403;
      return { error: "Forbidden origin" };
    }
    set.headers["access-control-allow-origin"] = origin!;
    const source = (body as { source?: string } | null)?.source;
    if (source !== "auto" && !PRIMARY_CHOICES.includes(source as Source)) {
      set.status = 400;
      return { error: "source must be upstox, tradingview or auto" };
    }
    mcxPrimary = source === "auto" ? undefined : (source as Source);
    redis.set("primary:mcx", mcxPrimary ?? "auto").catch(() => {});
    return { mcxPrimary: mcxPrimary ?? "auto" };
  })
  .get("/health", async ({ request, set }) => {
    // read by the web app / Tauri (Settings → Data feeds); other web pages may not read it
    const origin = request.headers.get("origin");
    if (origin && isAllowedOrigin(origin, ORIGINS)) set.headers["access-control-allow-origin"] = origin;
    const [pg, rd] = await Promise.allSettled([sql`SELECT 1`, redis.send("PING", [])]);
    return {
      service: "drishti-core-stream",
      postgres: pg.status === "fulfilled",
      redis: rd.status === "fulfilled",
      feed: DEMO ? "demo" : "live",
      providers: stats,
      rejected,
      prices: Object.fromEntries(lastPrice),
      active: Object.fromEntries(active),
      mcxPrimary: mcxPrimary ?? "auto",
      mcxStatus: mcxStatus ?? null,
      options: { watching: optionWatch.wanted().length, known: optionKeys.size, messages: optionStats.messages, lastAt: optionStats.lastAt, lagMedianMs: optionLag.pct(50) ?? null, lagP95Ms: optionLag.pct(95) ?? null, lagSamples: optionLag.count },
      recorder: feedRecorder?.stats ?? { on: false },
      capture: upstoxCapture?.stats ?? null,
      fronts: Object.fromEntries([...fronts].map(([k, r]) => [k, r.trading_symbol])),
      news: { items: currentNews().length, archive: archiveStats, feeds: newsStats },
    };
  })
  .ws("/ws", {
    maxPayloadLength: 16 * 1024,
    // a foreign web page open in the same browser must not be able to tap our feed
    beforeHandle({ request, set }) {
      if (!isAllowedOrigin(request.headers.get("origin"), ORIGINS)) {
        set.status = 403;
        return "Forbidden origin";
      }
    },
    open(ws) {
      ws.subscribe("hb");
      ws.send(heartbeat()); // freshness known immediately, not after the first 15 s tick
    },
    message(ws, raw) {
      if (!wsLimiter.take(ws.id)) return ws.close(1008, "rate limit");
      let msg: ClientMessage;
      try {
        msg = (typeof raw === "string" ? JSON.parse(raw) : raw) as ClientMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if ("watch" in msg) return void optionWatch.request(msg.watch); // option contracts this client shows; refused keys cost nothing
      const list = (("subscribe" in msg ? msg.subscribe : msg?.unsubscribe) ?? []) as unknown[];
      const topics = (Array.isArray(list) ? list : []).filter((t): t is string => typeof t === "string" && isTopic(t));
      if ("subscribe" in msg) {
        for (const s of topics) {
          if (s === "news") {
            ws.subscribe("news");
            ws.send(JSON.stringify({ type: "news", items: currentNews() }));
            continue;
          }
          if (s === "alerts" || s === "paper" || s === "briefing" || s === "options") {
            ws.subscribe(s);
            continue;
          }
          ws.subscribe(`quotes:${s}`);
          const snap = latest.get(s);
          if (snap) ws.send(JSON.stringify(snap)); // don't leave panels blank until the next trade
        }
      } else topics.forEach((s) => ws.unsubscribe(s === "news" || s === "alerts" || s === "paper" || s === "briefing" || s === "options" ? s : `quotes:${s}`));
    },
  })
  .listen({ port: PORT, hostname: HOST });

setInterval(() => app.server?.publish("hb", heartbeat()), HEARTBEAT_MS);

if (DEMO) {
  startDemo(accept);
} else {
  await refreshFronts();
  setInterval(refreshFronts, FRONTS_REFRESH_MS);
  void refreshOptionKeys();
  setInterval(refreshOptionKeys, 60 * 60_000);
  startUpstox(redis, upstoxTargets, accept, stats.upstox!, {
    keys: () => [...new Set([...optionWatch.wanted(), ...(feedRecorder?.keys() ?? [])])],
    onChange: (fn) => {
      optionWatch.onChange(fn);
      feedRecorder?.onChange(fn);
    },
    record: (q) => feedRecorder?.onOption(q),
    emit: (q) => {
      optionStats.messages++;
      optionStats.lastAt = q.recvAt;
      const prev = lastTrade.get(q.key);
      lastTrade.set(q.key, q.time);
      if (prev !== undefined && q.time > prev) optionLag.add(optionLagMs(q));
      app.server?.publish("options", JSON.stringify({ type: "opt", q }));
    },
  });
  startTradingView(tvTargets, accept, stats.tradingview!);
  startYahoo(
    () => INSTRUMENTS.filter((i) => i.yahoo),
    accept,
    stats.yahoo!,
  );
}

serverAlerts = startServerAlerts(sql, (json) => app.server?.publish("alerts", json), () => Object.fromEntries([...latest].map(([symbol, q]) => [symbol, { price: q.price, prevClose: q.prevClose }])));
startNews(redis, sql, (fresh) => {
  app.server?.publish("news", JSON.stringify({ type: "news", items: fresh }));
  serverAlerts?.onNews(fresh);
});

setInterval(async () => {
  if (!buffer.length) return;
  const rows = buffer.map((t) => ({ time: new Date(t.time), symbol: t.symbol, price: t.price, size: t.size }));
  buffer = [];
  try {
    await sql`INSERT INTO ticks ${sql(rows)}`;
  } catch (err) {
    console.error("tick insert failed, dropped", rows.length, (err as Error).message);
  }
}, FLUSH_MS);

console.log(`drishti-core-stream on http://${HOST}:${PORT} (${DEMO ? "demo feed" : "live feeds"})`);
