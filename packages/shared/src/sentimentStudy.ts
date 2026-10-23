// The pure pieces of the headline sentiment study (research/sentiment, deviations D1 and D2): which hourly bar an event enters on, the forward returns,
// the observation per entry bar, rolls dropped, the rank correlation with a permutation test, Holm's correction, and the two controls. No data access here.
import { touchesRoll } from "./clExpiry";

export interface Headline {
  /** when we could have known it (GDELT batch time), epoch ms */
  at: number;
  title: string;
}

/** An hourly bar: `time` is the open in epoch SECONDS, as everywhere else in the app. */
export interface HBar {
  time: number;
  open: number;
  close: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Index of the first bar that starts at least 60 seconds after t0 (the assumed latency), or -1. Bars must be in time order. */
export function entryIndex(bars: HBar[], t0: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time * 1000 >= t0 + 60_000) hi = mid;
    else lo = mid + 1;
  }
  return lo < bars.length ? lo : -1;
}

export interface Observation {
  /** the entry bar's open, epoch ms */
  entry: number;
  /** mean tone of the events that enter on this bar */
  tone: number;
  events: number;
  /** return over the entry bar: close / open - 1 */
  r60: number;
  /** return from the entry open to the close of the last bar starting before entry + 24 h; undefined when the market was shut for most of the day */
  r1d?: number;
}

export interface ObservationOptions {
  /** the tone of a headline, in [-1, 1] */
  tone: (title: string) => number;
  /** CL contract expiries (UTC midnight, ms); a window touching one is dropped */
  expiries: number[];
  /** move every event time by this many ms (the look-ahead test shifts it by +1 hour and expects different returns) */
  shiftMs?: number;
}

/**
 * One observation per entry bar: the mean tone of the headlines entering on it, and the returns from that bar's open. Events with no entry bar are
 * dropped, as are windows that touch a roll. Sorted by entry time.
 */
export function buildObservations(headlines: Headline[], bars: HBar[], opts: ObservationOptions): Observation[] {
  const byBar = new Map<number, number[]>();
  for (const h of headlines) {
    const i = entryIndex(bars, h.at + (opts.shiftMs ?? 0));
    if (i < 0) continue;
    const list = byBar.get(i) ?? [];
    list.push(opts.tone(h.title));
    byBar.set(i, list);
  }
  const out: Observation[] = [];
  for (const [i, tones] of [...byBar].sort((a, b) => a[0] - b[0])) {
    const b = bars[i];
    if (!(b.open > 0) || !(b.close > 0)) continue;
    const entry = b.time * 1000;
    if (touchesRoll(entry, entry + DAY + HOUR, opts.expiries)) continue;
    const obs: Observation = { entry, tone: tones.reduce((a, x) => a + x, 0) / tones.length, events: tones.length, r60: b.close / b.open - 1 };
    let j = i;
    while (j + 1 < bars.length && bars[j + 1].time * 1000 < entry + DAY) j++;
    if (bars[j].time * 1000 >= entry + 20 * HOUR && bars[j].close > 0) obs.r1d = bars[j].close / b.open - 1;
    out.push(obs);
  }
  return out;
}

/** Average ranks (ties share the mean rank), 1-based. */
export function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa === 0 || sbb === 0 ? 0 : sab / Math.sqrt(saa * sbb);
}

/** Spearman rank correlation (the information coefficient). */
export const spearman = (x: number[], y: number[]) => (x.length < 3 || x.length !== y.length ? 0 : pearson(ranks(x), ranks(y)));

/** A small seeded generator (mulberry32), so a permutation test gives the same answer twice. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface IcResult {
  n: number;
  ic: number;
  /** one-sided permutation p for IC > 0 (H1), with the +1 correction so it is never zero */
  p: number;
  /** the IC in standard errors of the permutation distribution */
  z: number;
}

/** The IC of tone against a return, and the share of tone shuffles that did as well. */
export function icTest(tone: number[], ret: number[], permutations = 10_000, seed = 1): IcResult {
  const n = tone.length;
  const ic = spearman(tone, ret);
  if (n < 10) return { n, ic, p: 1, z: 0 };
  const rt = ranks(tone);
  const rr = ranks(ret);
  const rand = rng(seed);
  let atLeast = 0;
  let sum = 0;
  let sumSq = 0;
  const shuffled = rt.slice();
  for (let k = 0; k < permutations; k++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const c = pearson(shuffled, rr);
    sum += c;
    sumSq += c * c;
    if (c >= ic - 1e-12) atLeast++;
  }
  const mean = sum / permutations;
  const sd = Math.sqrt(Math.max(1e-18, sumSq / permutations - mean * mean));
  return { n, ic, p: (atLeast + 1) / (permutations + 1), z: (ic - mean) / sd };
}

/** Holm-Bonferroni step-down: adjusted p-values in the input order (each at least as large as the one before it in rank order, capped at 1). */
export function holm(p: number[]): number[] {
  const order = p.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const adj = new Array<number>(p.length);
  let running = 0;
  order.forEach(([x, i], k) => {
    running = Math.max(running, Math.min(1, x * (p.length - k)));
    adj[i] = running;
  });
  return adj;
}

/** The negative control: tone shuffled across observations, so tone carries no information. Its IC must sit near zero (the run requires |z| < 2). */
export function shuffledControl(tone: number[], ret: number[], seed = 7): IcResult {
  const rand = rng(seed);
  const t = tone.slice();
  for (let i = t.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [t[i], t[j]] = [t[j], t[i]];
  }
  return icTest(t, ret, 2000, seed + 1);
}

/**
 * The look-ahead test: moving every event an hour later must change which bar (and so which return) the event is assigned. Returns the share of events whose
 * entry bar changed; a pipeline that ignored event time would return 0.
 */
export function lookAheadShift(headlines: Headline[], bars: HBar[]): number {
  let differ = 0;
  let n = 0;
  for (const h of headlines) {
    const a = entryIndex(bars, h.at);
    if (a < 0) continue;
    n++;
    if (entryIndex(bars, h.at + HOUR) !== a) differ++;
  }
  return n === 0 ? 0 : differ / n;
}
