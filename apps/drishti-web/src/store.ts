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
}

export const useStore = create<MarketState>()(() => ({
  status: "connecting",
  quotes: {},
  prev: {},
  news: [],
}));

let ws: WebSocket | undefined;

export function connectStream() {
  useStore.setState({ status: "connecting" });
  const sock = new WebSocket(streamUrl());
  ws = sock;
  sock.onopen = () => {
    useStore.setState({ status: "open" });
    sock.send(JSON.stringify({ subscribe: [...SYMBOLS, "news"] }));
  };
  sock.onmessage = (e) => {
    const msg: Quote | { type: "news"; items: NewsItem[] } = JSON.parse(e.data);
    if ("type" in msg) {
      useStore.setState((s) => ({ news: dedupeNews(s.news, msg.items) }));
      return;
    }
    const q = msg;
    useStore.setState((s) => ({
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
