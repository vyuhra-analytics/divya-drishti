import { Elysia } from "elysia";
import { RedisClient, SQL } from "bun";
import { SYMBOLS, type ClientMessage, type Tick } from "@drishti/shared";
import { nextTick } from "./feed";

const PORT = Number(process.env.STREAM_PORT ?? 3002);
const TICK_MS = 200;
const FLUSH_MS = 1000;

const sql = new SQL(process.env.DATABASE_URL!, { connectionTimeout: 2 });
const redis = new RedisClient(process.env.REDIS_URL, { enableOfflineQueue: false, connectionTimeout: 2000 });

const START: Record<string, number> = {
  NIFTY: 24500, BANKNIFTY: 52000, RELIANCE: 2900, TCS: 4100, INFY: 1850, HDFCBANK: 1700,
};
const last = new Map<string, Tick>(
  SYMBOLS.map((s) => [s, { symbol: s, time: Date.now(), price: START[s] ?? 100, size: 0 }]),
);
let buffer: Tick[] = [];

const app = new Elysia()
  .get("/health", async () => {
    const [pg, rd] = await Promise.allSettled([sql`SELECT 1`, redis.send("PING", [])]);
    return { service: "drishti-core-stream", postgres: pg.status === "fulfilled", redis: rd.status === "fulfilled" };
  })
  .ws("/ws", {
    message(ws, raw) {
      const msg = (typeof raw === "string" ? JSON.parse(raw) : raw) as ClientMessage;
      if ("subscribe" in msg) msg.subscribe.forEach((s) => ws.subscribe(`ticks:${s}`));
      else msg.unsubscribe.forEach((s) => ws.unsubscribe(`ticks:${s}`));
    },
  })
  .listen(PORT);

setInterval(() => {
  const now = Date.now();
  for (const prev of last.values()) {
    const tick = nextTick(prev, now);
    last.set(tick.symbol, tick);
    buffer.push(tick);
    const json = JSON.stringify(tick);
    app.server?.publish(`ticks:${tick.symbol}`, json);
    // ponytail: fire-and-forget Redis writes; add backpressure/metrics when real feeds arrive
    redis.send("PUBLISH", [`ticks:${tick.symbol}`, json]).catch(() => {});
    redis.set(`quote:${tick.symbol}`, json).catch(() => {});
  }
}, TICK_MS);

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

console.log(`drishti-core-stream on :${PORT}`);
