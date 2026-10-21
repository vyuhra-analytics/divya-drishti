// Futures curve: one price per delivery month, calendar spreads and the shape (contango or backwardation).
// Prices come from TradingView's public scanner by dated contract code (works for MCX and NYMEX); pure helpers, tested.
import { INSTRUMENTS, tvContract } from "./index";

/** Instruments with a futures curve: every one of ours (a function: index.ts re-exports this module, so INSTRUMENTS cannot be read at load). Root = TradingView's code without the continuous "1!". */
export const curveInstruments = () => INSTRUMENTS.filter((i) => i.exchange !== "FX").map((i) => ({ symbol: i.symbol, name: i.name, currency: i.currency, root: i.tv.replace(/1!$/, "") }));

/** Dated TradingView codes for the next `months` delivery months starting with the current one (CL, Nov 2026 → NYMEX:CLX2026). Months with no contract simply come back empty. */
export function curveCodes(root: string, now: number, months = 12): string[] {
  const d = new Date(now);
  return Array.from({ length: months }, (_, k) => tvContract(root, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1)));
}

export interface CurvePoint {
  code: string;
  /** contract expiry, UTC midnight epoch ms */
  expiry: number;
  price: number;
  volume?: number;
  /** price minus the previous (nearer) contract; absent on the first */
  spread?: number;
}

/** TradingView scan rows (columns close, volume, expiration as YYYYMMDD) → points, nearest first. Expired contracts and rows without a price are dropped. */
export function parseCurve(json: any, now: number): CurvePoint[] {
  const pts: CurvePoint[] = [];
  for (const r of json?.data ?? []) {
    const [price, volume, exp] = r.d ?? [];
    const s = String(exp);
    const expiry = /^\d{8}$/.test(s) ? Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) : NaN;
    if (typeof price !== "number" || !Number.isFinite(expiry) || expiry < now - (now % 86_400_000)) continue;
    pts.push({ code: r.s, expiry, price, volume: typeof volume === "number" ? volume : undefined });
  }
  pts.sort((a, b) => a.expiry - b.expiry);
  return pts.map((p, i) => ({ ...p, spread: i ? p.price - pts[i - 1].price : undefined }));
}

export type Shape = "contango" | "backwardation" | "flat";

export interface CurveSummary {
  shape: Shape;
  /** second contract minus the first, and last minus first */
  m1m2?: number;
  m1Last?: number;
  /** nearest roll as an annualised percent of the front price: positive when the front is dearer (backwardation = you earn it holding long) */
  rollYieldPct?: number;
}

/** Shape from the front-to-last change: more than 0.5% of the front price either way is contango/backwardation, else flat. */
export function summarizeCurve(pts: CurvePoint[]): CurveSummary | undefined {
  if (pts.length < 2) return undefined;
  const [a, b] = pts;
  const last = pts[pts.length - 1];
  const rel = (last.price - a.price) / a.price;
  const days = (b.expiry - a.expiry) / 86_400_000;
  return {
    shape: rel > 0.005 ? "contango" : rel < -0.005 ? "backwardation" : "flat",
    m1m2: b.price - a.price,
    m1Last: last.price - a.price,
    rollYieldPct: days > 0 ? ((a.price - b.price) / a.price) * (365 / days) * 100 : undefined,
  };
}
