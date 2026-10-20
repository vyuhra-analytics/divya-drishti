export const SYMBOLS = ["NIFTY", "BANKNIFTY", "RELIANCE", "TCS", "INFY", "HDFCBANK"] as const;
export type Symbol = (typeof SYMBOLS)[number];

/** time = epoch ms */
export interface Tick {
  symbol: string;
  time: number;
  price: number;
  size: number;
}

/** time = bucket start, epoch seconds (lightweight-charts UTCTimestamp) */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const TIMEFRAMES = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;

/** Merge a tick into the current bar, or start a new bar when the tick crosses into the next bucket. */
export function applyTick(bar: Bar | undefined, tick: Tick, tfSeconds: number): Bar {
  const bucket = Math.floor(tick.time / 1000 / tfSeconds) * tfSeconds;
  if (!bar || bucket > bar.time) {
    return { time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: tick.size };
  }
  if (bucket < bar.time) return bar; // late tick for an already-closed bar
  return {
    ...bar,
    high: Math.max(bar.high, tick.price),
    low: Math.min(bar.low, tick.price),
    close: tick.price,
    volume: bar.volume + tick.size,
  };
}

export type ClientMessage = { subscribe: string[] } | { unsubscribe: string[] };
