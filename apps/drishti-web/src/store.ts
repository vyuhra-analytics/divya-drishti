import { create } from "zustand";
import { applyTick, SYMBOLS, type Bar, type Tick } from "@drishti/shared";
import { streamUrl } from "./settings";

const DAY = 86400;

/** Live market data. UI/layout state lives in workspace.ts. */
interface MarketState {
  status: "connecting" | "open" | "closed";
  quotes: Record<string, Tick>;
  prev: Record<string, number>;
  /** Session OHLCV per symbol, built from ticks seen since load. */
  day: Record<string, Bar>;
}

export const useStore = create<MarketState>()(() => ({
  status: "connecting",
  quotes: {},
  prev: {},
  day: {},
}));

let ws: WebSocket | undefined;

export function connectStream() {
  useStore.setState({ status: "connecting" });
  const sock = new WebSocket(streamUrl());
  ws = sock;
  sock.onopen = () => {
    useStore.setState({ status: "open" });
    sock.send(JSON.stringify({ subscribe: SYMBOLS }));
  };
  sock.onmessage = (e) => {
    const tick: Tick = JSON.parse(e.data);
    useStore.setState((s) => ({
      quotes: { ...s.quotes, [tick.symbol]: tick },
      prev: { ...s.prev, [tick.symbol]: s.quotes[tick.symbol]?.price ?? tick.price },
      day: { ...s.day, [tick.symbol]: applyTick(s.day[tick.symbol], tick, DAY) },
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
