import type { Bar as OaBar, DataFeed } from "openalgo-charts";
import { applyTick, instrument, INSTRUMENTS, quoteToTick, TIMEFRAMES, tzOffsetSec, type Bar, type Timeframe } from "@drishti/shared";
import { apiUrl } from "./settings";
import { useStore } from "./store";

/** The intervals our history API serves; the advanced chart is limited to these. */
export const ADV_INTERVALS = ["1m", "5m", "15m", "1h", "1D"] as const;

/**
 * The instrument a typed symbol means: the full code ("MCX:NATURALGAS") or the bare name ("naturalgas"), when exactly one instrument matches. The list is read at call time
 * (instruments added in Settings change it in place).
 */
export function resolveSymbol(text: string, list: readonly { symbol: string }[] = INSTRUMENTS): string | undefined {
  const t = text.trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return undefined;
  const full = list.find((i) => i.symbol.toUpperCase() === t);
  if (full) return full.symbol;
  const bare = list.filter((i) => i.symbol.split(":").pop()!.toUpperCase() === t);
  return bare.length === 1 ? bare[0].symbol : undefined;
}

/** What the chart's symbol box offers while typing: our instruments whose code or name contains every word typed (all of them for an empty box). */
export function searchInstruments(query: string, list: readonly { symbol: string; name: string; exchange: string }[] = INSTRUMENTS) {
  const words = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
  return list
    .filter((i) => words.every((w) => `${i.symbol} ${i.name}`.toUpperCase().includes(w)))
    .map((i) => ({ symbol: i.symbol, exchange: i.exchange, name: i.name }));
}

/** openalgo-charts interval code ("5m", "1h", "1D") → our timeframe, or undefined when we can't serve it. */
export function timeframeOf(code: string): Timeframe | undefined {
  const m = /^(\d+)([mhDd])$/.exec(code);
  if (!m) return undefined;
  const sec = Number(m[1]) * { m: 60, h: 3600, D: 86400, d: 86400 }[m[2] as "m" | "h" | "D" | "d"];
  return (Object.keys(TIMEFRAMES) as Timeframe[]).find((tf) => TIMEFRAMES[tf] === sec);
}

const toOa = (b: Bar): OaBar => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, ...(b.oi !== undefined ? { oi: b.oi } : {}) });

/**
 * Our data behind openalgo-charts' DataFeed: history from the API's /bars (provider history, written through to
 * Timescale) and live candles built from the same quote stream our own chart uses.
 */
export function ourFeed(isPaused: () => boolean = () => false): DataFeed {
  // newest bar per symbol+timeframe, seeded by history and advanced by live ticks (the stream's volume deltas need the previous quote)
  const last = new Map<string, Bar>();
  const key = (symbol: string, tf: Timeframe) => `${symbol}|${tf}`;
  const inflight = new Map<string, Promise<Bar[]>>();
  return {
    async searchSymbols(req) {
      return searchInstruments(req.query);
    },
    async getBars(req) {
      const tf = timeframeOf(req.interval);
      if (!tf) throw new Error(`Interval ${req.interval} isn't available: choose one of ${ADV_INTERVALS.join(", ")}`);
      // the widget asks for the same window more than once while it starts up: share one request
      const k = key(req.symbol, tf);
      let pending = inflight.get(k);
      if (!pending) {
        pending = fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(req.symbol)}&tf=${tf}`, { signal: req.signal })
          .then(async (res) => {
            if (!res.ok) throw new Error(`History unavailable (${res.status})`);
            return (await res.json()) as Bar[];
          })
          .finally(() => inflight.delete(k));
        inflight.set(k, pending);
      }
      const bars = await pending;
      if (bars.length) last.set(k, bars[bars.length - 1]);
      return bars.filter((b) => (req.from === undefined || b.time >= req.from) && (req.to === undefined || b.time <= req.to)).map(toOa);
    },
    subscribeBars(req, onBar) {
      const tf = timeframeOf(req.interval);
      if (!tf) return () => {};
      const tz = instrument(req.symbol)?.timeZone;
      return useStore.subscribe((s, p) => {
        const q = s.quotes[req.symbol];
        const before = p.quotes[req.symbol];
        if (!q || q === before) return;
        const tick = quoteToTick(before?.source === q.source ? before : undefined, q);
        if (!tick) return;
        const prev = last.get(key(req.symbol, tf));
        const bar = applyTick(prev, tick, TIMEFRAMES[tf], tz ? tzOffsetSec(tz, tick.time) : 0);
        if (bar === prev) return;
        last.set(key(req.symbol, tf), bar);
        if (!isPaused()) onBar(toOa(bar)); // during replay the chart shows the past: live candles are still tracked, not drawn
      });
    },
  };
}
