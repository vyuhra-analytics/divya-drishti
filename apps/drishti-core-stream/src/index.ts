import { Elysia } from "elysia";
import { RedisClient, SQL } from "bun";
import {
  allowedOrigins,
  REDIS_OPTIONS,
  INSTRUMENTS,
  isAllowedOrigin,
  RateLimiter,
  SYMBOLS,
  instrument,
  pickSource,
  quoteToTick,
  tvContract,
  type ClientMessage,
  type Instrument,
  type Quote,
  type Source,
  type Tick,
} from "@drishti/shared";
import { loadFronts, type Fronts } from "./contracts";
import { newStats, type ProviderStats } from "./providers/provider";
import { startTradingView } from "./providers/tradingview";
import { startYahoo } from "./providers/yahoo";
import { demoStats, startDemo } from "./providers/demo";
import { startUpstox, type UpstoxTarget } from "./providers/upstox/upstox";
import { archiveStats, currentNews, newsStats, startNews } from "./news";

const PORT = Number(process.env.STREAM_PORT ?? 3002);
// Localhost only by default (see drishti-core-api main.ts); HOST=0.0.0.0 to expose deliberately.
const HOST = process.env.HOST ?? "127.0.0.1";
const ORIGINS = allowedOrigins(process.env.WEB_ORIGINS);
const TOPICS = new Set<string>([...SYMBOLS, "news"]);
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
const active = new Map<string, Source>();
let buffer: Tick[] = [];

function accept(q: Quote) {
  const inst = instrument(q.symbol);
  if (!inst) return;
  const now = Date.now();
  const seen = lastSeen.get(q.symbol) ?? {};
  seen[q.source] = now;
  lastSeen.set(q.symbol, seen);
  const winner = pickSource(seen, DEMO ? ["demo"] : inst.sources, now, STALE_MS);
  if (winner) active.set(q.symbol, winner);
  if (q.source !== winner) return;

  const prev = latest.get(q.symbol);
  if (prev && prev.source === q.source && prev.price === q.price && prev.volume === q.volume && prev.time === q.time) return;
  latest.set(q.symbol, q);
  // volume counts differ between sources, so only diff volumes within one source
  const tick = quoteToTick(prev?.source === q.source ? prev : undefined, q);
  if (tick) buffer.push(tick);

  const json = JSON.stringify(q);
  app.server?.publish(`quotes:${q.symbol}`, json);
  // ponytail: fire-and-forget Redis writes; add backpressure/metrics if they ever fall behind
  redis.send("PUBLISH", [`quotes:${q.symbol}`, json]).catch(() => {});
  redis.set(`quote:${q.symbol}`, json).catch(() => {});
}

// ---- front-month contracts (MCX) ----
let fronts: Fronts = new Map();
// drishti-core-api reads the instrument keys for Upstox history from Redis. Re-published every minute: a write
// made while Redis is (re)connecting is dropped (no offline queue), and Redis may restart without persistence.
const publishFronts = () => {
  if (fronts.size) redis.set("fronts", JSON.stringify(Object.fromEntries(fronts))).catch(() => {});
};
setInterval(publishFronts, 60_000);
async function refreshFronts() {
  try {
    fronts = await loadFronts();
    publishFronts();
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
    const ticker = front?.expiry ? tvContract(inst.tv, front.expiry) : inst.tv.endsWith("1!") ? inst.tv : `${inst.tv}1!`;
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

const app = new Elysia()
  // traded MCX contracts (instrument keys) for drishti-core-api's Upstox history when Redis isn't available
  .get("/fronts", () => Object.fromEntries(fronts))
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
      active: Object.fromEntries(active),
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
      const list = (("subscribe" in msg ? msg.subscribe : msg?.unsubscribe) ?? []) as unknown[];
      const topics = (Array.isArray(list) ? list : []).filter((t): t is string => typeof t === "string" && TOPICS.has(t));
      if ("subscribe" in msg) {
        for (const s of topics) {
          if (s === "news") {
            ws.subscribe("news");
            ws.send(JSON.stringify({ type: "news", items: currentNews() }));
            continue;
          }
          ws.subscribe(`quotes:${s}`);
          const snap = latest.get(s);
          if (snap) ws.send(JSON.stringify(snap)); // don't leave panels blank until the next trade
        }
      } else topics.forEach((s) => ws.unsubscribe(s === "news" ? "news" : `quotes:${s}`));
    },
  })
  .listen({ port: PORT, hostname: HOST });

setInterval(() => app.server?.publish("hb", JSON.stringify({ type: "hb", t: Date.now() })), HEARTBEAT_MS);

if (DEMO) {
  startDemo(accept);
} else {
  await refreshFronts();
  setInterval(refreshFronts, FRONTS_REFRESH_MS);
  startUpstox(redis, upstoxTargets, accept, stats.upstox!);
  startTradingView(tvTargets, accept, stats.tradingview!);
  startYahoo(
    INSTRUMENTS.filter((i) => i.yahoo),
    accept,
    stats.yahoo!,
  );
}

startNews(redis, sql, (fresh) => app.server?.publish("news", JSON.stringify({ type: "news", items: fresh })));

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
