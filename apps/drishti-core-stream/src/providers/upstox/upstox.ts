import protobuf from "protobufjs";
import { join } from "node:path";
import type { RedisClient } from "bun";
import { optionQuoteProblem, parseOptionFeed, type Instrument, type OptionQuote, type Quote } from "@drishti/shared";
import { subscriptionDiff } from "../../optionWatch";
import type { Emit, ProviderStats } from "../provider";

// Upstox Market Data Feed v3: authorize over REST, then a protobuf WebSocket.
// Token: today's login (Redis `upstox:token`, written by drishti-core-api) if present, else UPSTOX_ACCESS_TOKEN
// from .env (a token generated in the Upstox developer dashboard, e.g. the long-lived read-only analytics token).
const AUTHORIZE = "https://api.upstox.com/v3/feed/market-data-feed/authorize";
const TOKEN_CHECK_MS = 10_000;
const HEARTBEAT_MS = 5_000; // re-emit cached quotes so the router keeps Upstox as the fresh source in quiet markets

const FeedResponse = protobuf
  .loadSync(join(import.meta.dir, "MarketDataFeed.proto"))
  .lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");

export interface UpstoxTarget {
  inst: Instrument;
  contract: string;
}

const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));

/** Decoded FeedResponse (plain object) → quotes for the instruments we subscribed to. */
export function feedToQuotes(msg: any, targets: Map<string, UpstoxTarget>): Quote[] {
  const out: Quote[] = [];
  for (const [key, feed] of Object.entries<any>(msg?.feeds ?? {})) {
    const t = targets.get(key);
    const ff = feed?.fullFeed?.marketFF;
    const ltpc = ff?.ltpc ?? feed?.ltpc ?? feed?.firstLevelWithGreeks?.ltpc;
    if (!t || !ltpc?.ltp) continue;
    const day = ff?.marketOHLC?.ohlc?.find((o: any) => o.interval === "1d");
    const best = ff?.marketLevel?.bidAskQuote?.[0];
    out.push({
      symbol: t.inst.symbol,
      price: Number(ltpc.ltp),
      time: num(ltpc.ltt) ?? Date.now(),
      prevClose: num(ltpc.cp),
      open: num(day?.open),
      high: num(day?.high),
      low: num(day?.low),
      volume: num(ff?.vtt ?? feed?.firstLevelWithGreeks?.vtt),
      // depth/OI/ATP only in full mode; zeros mean "no order on that side", so keep them out
      bid: num(best?.bidP) || undefined,
      ask: num(best?.askP) || undefined,
      bidQty: num(best?.bidQ) || undefined,
      askQty: num(best?.askQ) || undefined,
      oi: num(ff?.oi) || undefined,
      atp: num(ff?.atp) || undefined,
      totalBuyQty: num(ff?.tbq) || undefined,
      totalSellQty: num(ff?.tsq) || undefined,
      contract: t.contract,
      source: "upstox",
      delayedBy: 0,
    });
  }
  return out;
}

/** Option contracts clients want live (see optionWatch.ts): subscribed on the same connection, added and dropped without reconnecting. */
export interface OptionFeed {
  keys: () => string[];
  /** register for changes of the wanted set */
  onChange: (fn: () => void) => void;
  emit: (q: OptionQuote) => void;
}

/**
 * Keeps one feed connection alive while a token exists. `targets()` maps instrument_key → our instrument;
 * when it changes (front-month roll) we resubscribe by reconnecting. Option keys named by `options` ride the same connection.
 */
export function startUpstox(redis: RedisClient, targets: () => Map<string, UpstoxTarget>, emit: Emit, stats: ProviderStats, options?: OptionFeed) {
  let ws: WebSocket | undefined;
  const subscribedOptions = new Set<string>();
  const send = (method: "sub" | "unsub", instrumentKeys: string[]) => {
    if (ws?.readyState !== WebSocket.OPEN || !instrumentKeys.length) return;
    const data = method === "sub" ? { mode: "full", instrumentKeys } : { instrumentKeys };
    ws.send(new TextEncoder().encode(JSON.stringify({ guid: crypto.randomUUID(), method, data })));
  };
  /** move the open socket from the subscribed option keys to the wanted ones */
  const syncOptions = () => {
    if (!options || ws?.readyState !== WebSocket.OPEN) return;
    const { sub, unsub } = subscriptionDiff(subscribedOptions, options.keys());
    send("unsub", unsub);
    send("sub", sub);
    unsub.forEach((k) => subscribedOptions.delete(k));
    sub.forEach((k) => subscribedOptions.add(k));
  };
  options?.onChange(syncOptions);
  let token: string | null = null;
  let keys = "";
  let backoff = 2000;
  let retryAt = 0;
  const latest = new Map<string, Quote>();

  const close = () => {
    const old = ws;
    ws = undefined;
    old?.close();
  };

  async function connect(tok: string) {
    const t = targets();
    if (!t.size) return;
    keys = [...t.keys()].sort().join(",");
    const res = await fetch(AUTHORIZE, {
      headers: { Accept: "application/json", Authorization: `Bearer ${tok}` },
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json().catch(() => ({}));
    const url = json?.data?.authorized_redirect_uri ?? json?.data?.authorizedRedirectUri;
    if (!res.ok || !url) throw new Error(`authorize ${res.status} ${json?.errors?.[0]?.errorCode ?? ""}`.trim());

    const sock = new WebSocket(url);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      backoff = 2000;
      subscribedOptions.clear();
      const wantedOptions = options?.keys() ?? [];
      wantedOptions.forEach((k) => subscribedOptions.add(k));
      const sub = { guid: crypto.randomUUID(), method: "sub", data: { mode: "full", instrumentKeys: [...t.keys(), ...wantedOptions] } };
      sock.send(new TextEncoder().encode(JSON.stringify(sub))); // Upstox wants the request as binary
    };
    sock.onmessage = (e) => {
      try {
        const msg = FeedResponse.toObject(FeedResponse.decode(new Uint8Array(e.data as ArrayBuffer)), { longs: Number });
        stats.ok++;
        stats.lastOkAt = Date.now();
        for (const q of feedToQuotes(msg, t)) {
          latest.set(q.symbol, q);
          emit(q);
        }
        if (options) {
          const recvAt = Date.now();
          for (const [key, feed] of Object.entries<any>(msg?.feeds ?? {})) {
            if (t.has(key) || !subscribedOptions.has(key)) continue;
            const oq = parseOptionFeed(key, feed, recvAt);
            if (oq && !optionQuoteProblem(oq)) options.emit(oq);
          }
        }
      } catch (err) {
        stats.failed++;
        stats.lastError = `decode: ${(err as Error).message}`;
      }
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = undefined;
      stats.lastError = `socket closed ${e.code}`;
      retryAt = Date.now() + backoff;
      backoff = Math.min(backoff * 2, 60_000);
    };
  }

  const tokenTimer = setInterval(async () => {
    try {
      const tok = (await redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim() || null;
      if (tok !== token) {
        token = tok; // new login (or expiry): start over
        close();
        retryAt = 0;
      }
      const changed = ws && [...targets().keys()].sort().join(",") !== keys;
      if (changed) close(); // contract roll
      if (token && !ws && Date.now() >= retryAt) {
        await connect(token).catch((err) => {
          stats.failed++;
          stats.lastError = (err as Error).message;
          retryAt = Date.now() + backoff;
          backoff = Math.min(backoff * 2, 60_000);
        });
      }
    } catch {
      // Redis down: keep whatever connection we have
    }
  }, TOKEN_CHECK_MS);

  const heartbeat = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) latest.forEach((q) => emit(q));
  }, HEARTBEAT_MS);

  return () => {
    clearInterval(tokenTimer);
    clearInterval(heartbeat);
    close();
  };
}
