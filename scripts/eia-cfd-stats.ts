// Pure statistics for scripts/eia-cfd-backtest.ts: seeded, so a run can be repeated exactly.
export const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** 95% interval of the average by resampling the trades with replacement. */
export function bootstrapCI(rs: readonly number[], runs = 2000, seed = 1): [number, number] | undefined {
  if (rs.length < 5) return undefined;
  const r = rng(seed);
  const means = Array.from({ length: runs }, () => mean(rs.map(() => rs[Math.floor(r() * rs.length)]))).sort((a, b) => a - b);
  return [means[Math.floor(runs * 0.025)], means[Math.floor(runs * 0.975)]];
}

/** One signal day: the R the trade would have made long and short, and the side the rule chose. */
export interface Day {
  long: number;
  short: number;
  side: "long" | "short";
}

/**
 * Does the surprise's direction matter? Gives every signal day a random side, many times, and reports the share of those draws that did at least as
 * well as the rule's sides (one-sided p). The entry, exits and days are the same, so only the direction is tested.
 */
export function randomSideP(days: readonly Day[], runs = 5000, seed = 1): { actual: number; randomMean: number; p: number } | undefined {
  if (!days.length) return undefined;
  const actual = mean(days.map((d) => d[d.side]));
  const r = rng(seed);
  let atLeast = 0;
  let sum = 0;
  for (let i = 0; i < runs; i++) {
    const m = mean(days.map((d) => (r() < 0.5 ? d.long : d.short)));
    sum += m;
    if (m >= actual) atLeast++;
  }
  return { actual, randomMean: sum / runs, p: (atLeast + 1) / (runs + 1) };
}

export interface RSummary {
  n: number;
  mean: number;
  winRate: number;
  profitFactor: number | undefined;
  /** deepest fall of the running total, in R */
  maxDrawdown: number;
  ci: [number, number] | undefined;
}

/** `rs` in time order. */
export function summarizeR(rs: readonly number[]): RSummary {
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const x of rs) {
    cum += x;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const gain = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const loss = -rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return { n: rs.length, mean: mean(rs), winRate: rs.length ? rs.filter((x) => x > 0).length / rs.length : NaN, profitFactor: loss > 0 ? gain / loss : undefined, maxDrawdown: dd, ci: bootstrapCI(rs) };
}
