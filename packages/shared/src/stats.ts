// Price statistics for the briefing and later panels: volatility, ATR, Hurst exponent, drawdown, regime.
// Pure and tested; the model is handed these numbers, never asked to compute them.
import type { Bar } from "./index";

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: number[]) => {
  if (xs.length < 2) return undefined;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Log returns of consecutive closes. */
export const logReturns = (bars: Bar[]) => bars.slice(1).map((b, i) => Math.log(b.close / bars[i].close));

/** Bars per year for a chart timeframe, for annualising volatility. ponytail: assumes ~14 trading hours a day, 252 days; exact only for 1D */
export function barsPerYear(timeframe: string): number | undefined {
  const per: Record<string, number> = { "1m": 840, "5m": 168, "15m": 56, "1h": 14, "1D": 1 };
  return per[timeframe] === undefined ? undefined : per[timeframe] * 252;
}

/** Realized volatility: standard deviation of the last `window` log returns, annualised, in percent. */
export function realizedVol(bars: Bar[], window: number, perYear: number): number | undefined {
  const r = logReturns(bars).slice(-window);
  const s = r.length >= Math.min(window, 10) ? sd(r) : undefined;
  return s === undefined ? undefined : s * Math.sqrt(perYear) * 100;
}

/** Where the latest `window` volatility sits among all rolling windows of the series, 0–100 (a volatility "cone" position). */
export function volPercentile(bars: Bar[], window: number): number | undefined {
  const r = logReturns(bars);
  if (r.length < window * 3) return undefined;
  const vols: number[] = [];
  for (let i = window; i <= r.length; i++) vols.push(sd(r.slice(i - window, i))!);
  const now = vols[vols.length - 1];
  return (vols.filter((v) => v <= now).length / vols.length) * 100;
}

/** Average true range (Wilder smoothing) over `period` bars: the typical bar-to-bar range in price units. */
export function atr(bars: Bar[], period = 14): number | undefined {
  if (bars.length <= period) return undefined;
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  let a = mean(tr.slice(0, period));
  for (const t of tr.slice(period)) a = (a * (period - 1) + t) / period;
  return a;
}

/** Hurst exponent by rescaled range over log returns: ~0.5 random walk, above 0.5 trending, below mean-reverting. Needs ≥ 64 returns. */
export function hurst(bars: Bar[]): number | undefined {
  const r = logReturns(bars);
  if (r.length < 64) return undefined;
  const pts: [number, number][] = [];
  for (let n = 8; n <= r.length / 2; n *= 2) {
    const rs: number[] = [];
    for (let i = 0; i + n <= r.length; i += n) {
      const seg = r.slice(i, i + n);
      const m = mean(seg);
      let cum = 0, hi = 0, lo = 0;
      for (const x of seg) { cum += x - m; hi = Math.max(hi, cum); lo = Math.min(lo, cum); }
      const s = sd(seg);
      if (s) rs.push((hi - lo) / s);
    }
    if (rs.length) pts.push([Math.log(n), Math.log(mean(rs))]);
  }
  if (pts.length < 3) return undefined;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  return slope;
}

/** Largest peak-to-trough fall of the closes, percent (a positive number), and how far below the peak the latest close is. */
export function drawdown(bars: Bar[]): { max: number; current: number } | undefined {
  if (bars.length < 2) return undefined;
  let peak = bars[0].close, max = 0;
  for (const b of bars) {
    peak = Math.max(peak, b.close);
    max = Math.max(max, (peak - b.close) / peak);
  }
  return { max: max * 100, current: ((peak - bars[bars.length - 1].close) / peak) * 100 };
}

export type Regime = "trending" | "mean-reverting" | "random";

/** Hurst well above or below 0.5 (±0.08, since the estimate is noisy on a few hundred bars) names the regime. */
export const regimeOf = (h: number | undefined): Regime | undefined => (h === undefined ? undefined : h >= 0.58 ? "trending" : h <= 0.42 ? "mean-reverting" : "random");
