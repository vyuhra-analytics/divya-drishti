import { create } from "zustand";
import { dedupeNews, SYMBOLS, type NewsItem, type Quote } from "@drishti/shared";
import { streamUrl } from "./settings";

/** Live market data. UI/layout state lives in workspace.ts. */
interface MarketState {
  status: "connecting" | "open" | "closed";
  /** latest provider snapshot per symbol (price, day OHLC, volume, contract, source) */
  quotes: Record<string, Quote>;
  /** previous price per symbol, for tick-direction colouring */
  prev: Record<string, number>;
  /** energy headlines, newest first (pushed by the stream service) */
  news: NewsItem[];
  /** +1 on every (re)connect: charts re-fetch history so candles missed while disconnected get filled */
  epoch: number;
  /** per symbol: when the server last heard from its active source (heartbeat), for STALE detection */
  seen: Record<string, number>;
}

export const useStore = create<MarketState>()(() => ({
  status: "connecting",
  quotes: {},
  prev: {},
  news: [],
  epoch: 0,
  seen: {},
}));

// The stream sends a heartbeat every 15 s. A socket can die without a close event (laptop sleep, Wi-Fi switch,
// proxy idle timeout) and would otherwise show frozen prices forever; after 45 s of silence, reconnect.
const SILENCE_MS = 45_000;
let lastMessageAt = 0;
setInterval(() => {
  if (useStore.getState().status === "open" && Date.now() - lastMessageAt > SILENCE_MS) reconnect();
}, 5_000);

let ws: WebSocket | undefined;

export function connectStream() {
  useStore.setState({ status: "connecting" });
  const sock = new WebSocket(streamUrl());
  ws = sock;
  sock.onopen = () => {
    lastMessageAt = Date.now();
    useStore.setState((s) => ({ status: "open", epoch: s.epoch + 1 }));
    sock.send(JSON.stringify({ subscribe: [...SYMBOLS, "news"] }));
  };
  sock.onmessage = (e) => {
    lastMessageAt = Date.now();
    const msg: Quote | { type: "news"; items: NewsItem[] } | { type: "hb"; seen?: Record<string, number> } = JSON.parse(e.data);
    if ("type" in msg) {
      if (msg.type === "news") useStore.setState((s) => ({ news: dedupeNews(s.news, msg.items) }));
      if (msg.type === "hb" && msg.seen) useStore.setState((s) => ({ seen: { ...s.seen, ...msg.seen } }));
      return;
    }
    const q = msg;
    useStore.setState((s) => ({
      seen: { ...s.seen, [q.symbol]: Date.now() },
      quotes: { ...s.quotes, [q.symbol]: q },
      prev: { ...s.prev, [q.symbol]: s.quotes[q.symbol]?.price ?? q.price },
    }));
  };
  sock.onclose = () => {
    if (ws !== sock) return; // replaced by reconnect()
    useStore.setState({ status: "closed" });
    setTimeout(() => ws === sock && connectStream(), 1000);
  };
}

/** Drop the current socket and connect again (e.g. after the stream URL changed). */
export function reconnect() {
  const old = ws;
  ws = undefined;
  old?.close();
  connectStream();
}
