import { create } from "zustand";
import { SYMBOLS, type Quote } from "@drishti/shared";
import { streamUrl } from "./settings";

/** Live market data. UI/layout state lives in workspace.ts. */
interface MarketState {
  status: "connecting" | "open" | "closed";
  /** latest provider snapshot per symbol (price, day OHLC, volume, contract, source) */
  quotes: Record<string, Quote>;
  /** previous price per symbol, for tick-direction colouring */
  prev: Record<string, number>;
}

export const useStore = create<MarketState>()(() => ({
  status: "connecting",
  quotes: {},
  prev: {},
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
    const q: Quote = JSON.parse(e.data);
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
