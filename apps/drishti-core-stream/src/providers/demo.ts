import { INSTRUMENTS, type Tick } from "@drishti/shared";
import { nextTick } from "../feed";
import { newStats, type Emit } from "./provider";

// Offline / weekend feed (FEED=demo): random walk around recent real levels.
const START: Record<string, number> = {
  "MCX:CRUDEOIL": 9340,
  "MCX:CRUDEOILM": 9340,
  "MCX:NATURALGAS": 283,
  "MCX:NATGASMINI": 283,
  "NYMEX:CL": 98,
  "NYMEX:NG": 2.97,
  "FX:USDINR": 94.45,
};

export const demoStats = newStats();

export function startDemo(emit: Emit) {
  const state = new Map<string, { tick: Tick; volume: number; prevClose: number }>(
    INSTRUMENTS.map((i) => [i.symbol, { tick: { symbol: i.symbol, time: Date.now(), price: START[i.symbol], size: 0 }, volume: 0, prevClose: START[i.symbol] }]),
  );
  const id = setInterval(() => {
    for (const s of state.values()) {
      if (Math.random() > 0.5) continue; // ~1 tick/s per symbol, irregular
      s.tick = nextTick(s.tick, Date.now());
      s.volume += s.tick.size;
      demoStats.ok++;
      demoStats.lastOkAt = Date.now();
      emit({ symbol: s.tick.symbol, price: s.tick.price, time: s.tick.time, prevClose: s.prevClose, volume: s.volume, source: "demo", delayedBy: 0 });
    }
  }, 500);
  return () => clearInterval(id);
}
