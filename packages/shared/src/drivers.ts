// What drives an MCX energy future: the NYMEX contract it follows and the rupee. MCX crude is quoted in rupees a barrel and MCX gas in rupees per mmBtu,
// so its fair value is the NYMEX price times USD/INR (checked live 2026-10-23: CL 100.29 x 94.87 = 9,514 against MCX 9,549, +0.36%; NG 2.727 x 94.87 = 258.7
// against 259.7). The gap (the premium) is worth watching, and the day's move splits into the NYMEX part, the rupee part and the change in the premium.
// The free NYMEX feeds are 10 minutes delayed and Upstox carries no NYMEX, so this is context for the live MCX price, never a lead signal.
import type { Bar, Quote } from "./index";

/** MCX symbol to the NYMEX contract that drives it. */
export const DRIVER_PAIRS: Readonly<Record<string, string>> = {
  "MCX:CRUDEOIL": "NYMEX:CL",
  "MCX:CRUDEOILM": "NYMEX:CL",
  "MCX:NATURALGAS": "NYMEX:NG",
  "MCX:NATGASMINI": "NYMEX:NG",
};

export const FX_SYMBOL = "FX:USDINR";

export interface DriverLeg {
  symbol: string;
  price: number;
  prevClose?: number;
  /** the day's change against the previous close, in the leg's own price units, and in percent */
  change?: number;
  changePct?: number;
  /** minutes this feed runs behind (0 = live) */
  delayMin: number;
  time: number;
  source: string;
}

export interface Drivers {
  mcx?: DriverLeg;
  global?: DriverLeg;
  fx?: DriverLeg;
  /** NYMEX price times USD/INR, in MCX's own unit */
  fair?: number;
  /** MCX minus the fair value, in rupees, and in percent of the fair value */
  premium?: number;
  premiumPct?: number;
  /** the MCX day move in percentage points, split into the NYMEX move, the rupee move and the change in the premium (the three add up to the total) */
  split?: { total: number; global: number; fx: number; premium: number };
}

const leg = (q?: Quote): DriverLeg | undefined =>
  q && Number.isFinite(q.price) && q.price > 0
    ? { symbol: q.symbol, price: q.price, prevClose: q.prevClose, change: q.prevClose ? q.price - q.prevClose : undefined, changePct: q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : undefined, delayMin: Math.round((q.delayedBy ?? 0) / 60), time: q.time, source: q.source }
    : undefined;

const logPct = (a: number, b: number) => Math.log(a / b) * 100;
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * The three legs, the fair value and the premium, and the split of the day move. The split uses log returns against each leg's own previous close, so
 * it adds up exactly; it needs all three previous closes, and the NYMEX close and the MCX close are not the same moment, which shows up as premium.
 */
export function computeDrivers(mcxQuote?: Quote, globalQuote?: Quote, fxQuote?: Quote): Drivers {
  const mcx = leg(mcxQuote);
  const global = leg(globalQuote);
  const fx = leg(fxQuote);
  const out: Drivers = { mcx, global, fx };
  if (mcx && global && fx) {
    out.fair = global.price * fx.price;
    out.premium = mcx.price - out.fair;
    out.premiumPct = (out.premium / out.fair) * 100;
    if (mcx.prevClose && global.prevClose && fx.prevClose) {
      const total = logPct(mcx.price, mcx.prevClose);
      const g = logPct(global.price, global.prevClose);
      const f = logPct(fx.price, fx.prevClose);
      out.split = { total: round(total, 3), global: round(g, 3), fx: round(f, 3), premium: round(total - g - f, 3) };
    }
  }
  return out;
}

export interface PremiumPoint {
  time: number;
  premium: number;
  premiumPct: number;
}

/** The premium at every bar the three instruments share (bars joined on their open time; a bar missing from any of them is skipped). */
export function premiumSeries(mcx: Bar[], global: Bar[], fx: Bar[]): PremiumPoint[] {
  const g = new Map(global.map((b) => [b.time, b.close]));
  const f = new Map(fx.map((b) => [b.time, b.close]));
  return mcx.flatMap((b): PremiumPoint[] => {
    const gc = g.get(b.time);
    const fc = f.get(b.time);
    if (gc === undefined || fc === undefined || !(gc > 0) || !(fc > 0) || !(b.close > 0)) return [];
    const fair = gc * fc;
    return [{ time: b.time, premium: b.close - fair, premiumPct: ((b.close - fair) / fair) * 100 }];
  });
}

export interface PremiumStats {
  n: number;
  min: number;
  max: number;
  median: number;
  /** where the current premium sits among the history, 0 to 100 (50 = the middle) */
  rank: number;
}

/** The history's range and where `current` (percent) sits in it; undefined with fewer than 20 points, too few to call anything usual. */
export function premiumStats(series: PremiumPoint[], current: number): PremiumStats | undefined {
  if (series.length < 20) return undefined;
  const v = series.map((p) => p.premiumPct).sort((a, b) => a - b);
  const below = v.filter((x) => x < current).length;
  return { n: v.length, min: v[0], max: v[v.length - 1], median: v[Math.floor(v.length / 2)], rank: Math.round((below / v.length) * 100) };
}
