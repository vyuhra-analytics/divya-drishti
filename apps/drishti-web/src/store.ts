import { create } from "zustand";
import { SYMBOLS, type Tick, type Timeframe } from "@drishti/shared";

export const API_URL = import.meta.env.VITE_API_URL || "/api";
const STREAM_URL =
  import.meta.env.VITE_STREAM_URL || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

interface State {
  status: "connecting" | "open" | "closed";
  active: string;
  tf: Timeframe;
  quotes: Record<string, Tick>;
  prev: Record<string, number>;
  setActive: (symbol: string) => void;
  setTf: (tf: Timeframe) => void;
}

export const useStore = create<State>()((set) => ({
  status: "connecting",
  active: SYMBOLS[0],
  tf: "1m",
  quotes: {},
  prev: {},
  setActive: (active) => set({ active }),
  setTf: (tf) => set({ tf }),
}));

export function connectStream() {
  useStore.setState({ status: "connecting" });
  const ws = new WebSocket(STREAM_URL);
  ws.onopen = () => {
    useStore.setState({ status: "open" });
    ws.send(JSON.stringify({ subscribe: SYMBOLS }));
  };
  ws.onmessage = (e) => {
    const tick: Tick = JSON.parse(e.data);
    useStore.setState((s) => ({
      quotes: { ...s.quotes, [tick.symbol]: tick },
      prev: { ...s.prev, [tick.symbol]: s.quotes[tick.symbol]?.price ?? tick.price },
    }));
  };
  ws.onclose = () => {
    useStore.setState({ status: "closed" });
    setTimeout(connectStream, 1000);
  };
}
