// Chart indicators, matching TradingView's Pine built-ins so values agree with what traders compare against.
// All take bars oldest→newest and return points aligned to bar times; warm-up bars are omitted.
import { bucketStart, type Bar } from "./index";

export interface Point {
  time: number;
  value: number;
}

/** ta.sma — rolling mean of closes. */
export function sma(bars: Bar[], period: number): Point[] {
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
  }
  return out;
}

/** EMA of a series. Pine's ta.ema seeds with the first value (not an SMA); we hide the first period-1 warm-up points. */
function emaValues(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) out.push(i === 0 ? values[0] : values[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** ta.ema */
export function ema(bars: Bar[], period: number): Point[] {
  const v = emaValues(
    bars.map((b) => b.close),
    period,
  );
  return bars.slice(period - 1).map((b, i) => ({ time: b.time, value: v[i + period - 1] }));
}

/** ta.bb(close, period, mult): SMA basis ± mult × population standard deviation (Pine's ta.stdev is biased). Rolling O(n). */
export function bollinger(bars: Bar[], period = 20, mult = 2) {
  const upper: Point[] = [];
  const middle: Point[] = [];
  const lower: Point[] = [];
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].close;
    sum += c;
    sumSq += c * c;
    if (i >= period) {
      const old = bars[i - period].close;
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      const sd = Math.sqrt(Math.max(0, sumSq / period - mean * mean));
      const time = bars[i].time;
      middle.push({ time, value: mean });
      upper.push({ time, value: mean + mult * sd });
      lower.push({ time, value: mean - mult * sd });
    }
  }
  return { upper, middle, lower };
}

/** ta.rsi — Wilder's smoothing (ta.rma, seeded with the simple average of the first `period` changes). */
export function rsi(bars: Bar[], period = 14): Point[] {
  const out: Point[] = [];
  let gain = 0;
  let loss = 0;
  const value = () => (loss === 0 ? 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss));
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= period) {
      gain += g / period;
      loss += l / period;
      if (i === period) out.push({ time: bars[i].time, value: value() });
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out.push({ time: bars[i].time, value: value() });
    }
  }
  return out;
}

/** ta.macd(close, fast, slow, signal): EMA(fast) − EMA(slow), its EMA(signal), and the histogram. */
export function macd(bars: Bar[], fast = 12, slow = 26, signal = 9) {
  const closes = bars.map((b) => b.close);
  const f = emaValues(closes, fast);
  const s = emaValues(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const sig = emaValues(line, signal);
  const from = slow + signal - 2; // hide warm-up of both stages
  const pick = (vals: number[]) => bars.slice(from).map((b, i) => ({ time: b.time, value: vals[i + from] }));
  return {
    macd: pick(line),
    signal: pick(sig),
    histogram: pick(line.map((v, i) => v - sig[i])),
  };
}

/**
 * ta.vwap anchored to the exchange session day: Σ(hlc3·volume) / Σvolume, reset at each exchange-local midnight.
 * (A VWAP that runs over the whole loaded range, as OpenTerminal's does, drifts meaninglessly on intraday charts.)
 * `offsetOf(sec)` gives the exchange's UTC offset at that instant (tzOffsetSec bound to the instrument's zone).
 */
export function vwap(bars: Bar[], offsetOf: (sec: number) => number = () => 0): Point[] {
  const out: Point[] = [];
  let day = Number.NaN;
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const d = bucketStart(b.time, 86_400, offsetOf(b.time));
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    vol += b.volume;
    if (vol > 0) out.push({ time: b.time, value: pv / vol });
  }
  return out;
}
