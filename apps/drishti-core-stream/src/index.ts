import { Elysia } from "elysia";
import { RedisClient, SQL } from "bun";
import {
  INSTRUMENTS,
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

const PORT = Number(process.env.STREAM_PORT ?? 3002);
const DEMO = process.env.FEED === "demo";
const STALE_MS = 15_000; // a source silent this long hands over to the next one
const FLUSH_MS = 1000;
const FRONTS_REFRESH_MS = 6 * 3600_000;

const sql = new SQL(process.env.DATABASE_URL!, { connectionTimeout: 2 });
const redis = new RedisClient(process.env.REDIS_URL, { enableOfflineQueue: false, connectionTimeout: 2000 });

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
async function refreshFronts() {
  try {
    fronts = await loadFronts();
    // drishti-core-api needs the instrument keys for Upstox history
    redis.set("fronts", JSON.stringify(Object.fromEntries(fronts))).catch(() => {});
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
  .get("/health", async ({ set }) => {
    set.headers["access-control-allow-origin"] = "*"; // read by the web app / Tauri (Settings → Connection)
    const [pg, rd] = await Promise.allSettled([sql`SELECT 1`, redis.send("PING", [])]);
    return {
      service: "drishti-core-stream",
      postgres: pg.status === "fulfilled",
      redis: rd.status === "fulfilled",
      feed: DEMO ? "demo" : "live",
      providers: stats,
      active: Object.fromEntries(active),
      fronts: Object.fromEntries([...fronts].map(([k, r]) => [k, r.trading_symbol])),
    };
  })
  .ws("/ws", {
    message(ws, raw) {
      const msg = (typeof raw === "string" ? JSON.parse(raw) : raw) as ClientMessage;
      if ("subscribe" in msg) {
        for (const s of msg.subscribe) {
          ws.subscribe(`quotes:${s}`);
          const snap = latest.get(s);
          if (snap) ws.send(JSON.stringify(snap)); // don't leave panels blank until the next trade
        }
      } else msg.unsubscribe.forEach((s) => ws.unsubscribe(`quotes:${s}`));
    },
  })
  .listen(PORT);

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

console.log(`drishti-core-stream on :${PORT} (${DEMO ? "demo feed" : "live feeds"})`);
