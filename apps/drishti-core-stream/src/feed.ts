import type { Tick } from "@drishti/shared";

/** Gaussian-ish random walk step: ~0.05% stdev per tick. rand injected for tests. */
export function nextTick(prev: Tick, now: number, rand = Math.random): Tick {
  const shock = (rand() + rand() + rand() - 1.5) * 0.001;
  return {
    symbol: prev.symbol,
    time: now,
    price: Math.max(0.05, +(prev.price * (1 + shock)).toFixed(2)),
    size: 1 + Math.floor(rand() * 100),
  };
}
