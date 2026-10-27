// What each named window of the New York day looks like: the high, low, range and average price of every window on every day, and how active each is
// (the range of an average minute, volume a minute) so a short window and a long one compare fairly. The windows are the five ICT killzones plus the
// gaps between them, named, so the table shows whether the killzones really are the busy hours or whether the quiet hours were simply left out.
// Pure and tested; the API route is apps/drishti-core-api/src/time-profile.ts and the panel is web TimeProfileView.tsx.
import { LONDON_OPEN_WINDOW, londonClock, nyClock, ZONES, type ZoneId } from "./sessionZones";

export interface ProfileWindow {
  id: string;
  label: string;
  /** minutes after midnight New York time; `to` is exclusive */
  from: number;
  to: number;
  /** one of the five ICT killzones (the rest are the named gaps between them) */
  killzone: boolean;
}

const gap = (id: string, label: string, from: number, to: number): ProfileWindow => ({ id, label, from, to, killzone: false });
const kz = (id: ZoneId): ProfileWindow => {
  const z = ZONES.find((x) => x.id === id)!;
  return { id, label: z.label, from: z.from, to: z.to, killzone: true };
};

/** The whole New York day, in order from the evening that opens it: no minute belongs to two windows. */
export const PROFILE_WINDOWS: readonly ProfileWindow[] = [
  kz("asian"),
  gap("overnight", "Overnight", 0, 2 * 60),
  kz("london"),
  gap("prelondon", "Pre-New York", 5 * 60, 7 * 60),
  kz("nyam"),
  kz("lclose"),
  gap("lunch", "New York lunch", 12 * 60, 13 * 60 + 30),
  kz("nypm"),
  gap("late", "New York late", 16 * 60, 20 * 60),
];

export interface ProfileBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface ZoneDay {
  /** New York date of the window */
  day: string;
  window: string;
  label: string;
  killzone: boolean;
  high: number;
  low: number;
  /** high - low */
  range: number;
  /** the mean of the bars' closing prices inside the window */
  average: number;
  volume: number;
  bars: number;
  /** the open time of the window's first bar and the end of its last (epoch seconds), for drawing it */
  start: number;
  end: number;
}

export interface WindowSummary {
  window: string;
  label: string;
  killzone: boolean;
  /** days with enough bars in the window */
  days: number;
  /** averages over those days: the window's high-low range in price points and as a percentage of its average price */
  avgRange: number;
  avgRangePct: number;
  /** the high-low range of an average bar, as a percentage of price: comparable between a 2-hour and a 4-hour window */
  avgBarRangePct: number;
  /** volume per minute of the window */
  volumePerMin: number;
}

/** A window counts on a day only when its bars cover at least this share of it (an MCX chart sees 30 of the 240 Asian minutes, so it has none). */
export const MIN_WINDOW_COVERAGE = 0.6;

/** The bar length in seconds: the smallest gap between neighbouring bars. 0 without two bars. */
function barSecs(bars: readonly { time: number }[]): number {
  let best = Infinity;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].time - bars[i - 1].time;
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/** Every window of every New York day in the bars: its high, low, range, average and volume. A day with too few bars in a window has no row for it. */
export function zoneDays(bars: readonly ProfileBar[], opts: { londonOpen?: boolean } = {}): ZoneDay[] {
  const tf = barSecs(bars);
  if (!tf || tf >= 3600) return []; // hourly bars cannot resolve a 90-minute window
  const acc = new Map<string, { w: ProfileWindow; day: string; high: number; low: number; sum: number; volume: number; n: number; first: number; last: number }>();
  for (const b of bars) {
    const { date, minutes } = nyClock(b.time);
    // London anchored to its own cash open: its window is London's 07:00 to 10:00, and New York's 02:00 to 05:00 is then no window at all
    const ldn = opts.londonOpen ? londonClock(b.time).minutes : 0;
    const inLdn = opts.londonOpen && ldn >= LONDON_OPEN_WINDOW.from && ldn < LONDON_OPEN_WINDOW.to;
    const w = inLdn ? PROFILE_WINDOWS.find((x) => x.id === "london") : PROFILE_WINDOWS.find((x) => minutes >= x.from && minutes < x.to && !(opts.londonOpen && x.id === "london"));
    if (!w) continue;
    const key = `${date}|${w.id}`;
    const a = acc.get(key) ?? { w, day: date, high: -Infinity, low: Infinity, sum: 0, volume: 0, n: 0, first: b.time, last: b.time };
    a.high = Math.max(a.high, b.high);
    a.low = Math.min(a.low, b.low);
    a.sum += b.close;
    a.volume += b.volume ?? 0;
    a.n++;
    a.first = Math.min(a.first, b.time);
    a.last = Math.max(a.last, b.time);
    acc.set(key, a);
  }
  const out: ZoneDay[] = [];
  for (const a of acc.values()) {
    const minutes = a.w.to - a.w.from;
    if ((a.n * tf) / 60 < minutes * MIN_WINDOW_COVERAGE) continue;
    out.push({ day: a.day, window: a.w.id, label: a.w.label, killzone: a.w.killzone, high: a.high, low: a.low, range: a.high - a.low, average: a.sum / a.n, volume: a.volume, bars: a.n, start: a.first, end: a.last + tf });
  }
  return out.sort((x, y) => (x.day === y.day ? order(x.window) - order(y.window) : x.day < y.day ? -1 : 1));
}

const order = (id: string) => PROFILE_WINDOWS.findIndex((w) => w.id === id);

/**
 * Per window across all days: the average range, and how active an average bar and an average minute is. `bars` are needed again for the per-bar
 * measure (the range of an average bar is not recoverable from a window's range).
 */
export function summarizeWindows(days: readonly ZoneDay[], bars: readonly ProfileBar[]): WindowSummary[] {
  const tf = barSecs(bars);
  const barRange = new Map<string, { sum: number; n: number }>();
  for (const b of bars) {
    const { minutes } = nyClock(b.time);
    const w = PROFILE_WINDOWS.find((x) => minutes >= x.from && minutes < x.to);
    if (!w || !(b.close > 0)) continue;
    const r = barRange.get(w.id) ?? { sum: 0, n: 0 };
    r.sum += ((b.high - b.low) / b.close) * 100;
    r.n++;
    barRange.set(w.id, r);
  }
  return PROFILE_WINDOWS.flatMap((w) => {
    const ds = days.filter((d) => d.window === w.id);
    if (!ds.length) return [];
    const mean = (f: (d: ZoneDay) => number) => ds.reduce((a, d) => a + f(d), 0) / ds.length;
    const br = barRange.get(w.id);
    const minutes = ds.reduce((a, d) => a + (d.bars * tf) / 60, 0);
    return [
      {
        window: w.id,
        label: w.label,
        killzone: w.killzone,
        days: ds.length,
        avgRange: mean((d) => d.range),
        avgRangePct: mean((d) => (d.range / d.average) * 100),
        avgBarRangePct: br ? br.sum / br.n : 0,
        volumePerMin: minutes > 0 ? ds.reduce((a, d) => a + d.volume, 0) / minutes : 0,
      },
    ];
  });
}

export const PROFILE_UNDERLYINGS = ["CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI"] as const;
export type ProfileUnderlying = (typeof PROFILE_UNDERLYINGS)[number];

export interface WindowProfile extends WindowSummary {
  /** the average bid-ask spread as a percentage of the mid price while the window was open, from our own recording of the feed; undefined before the recording had rows */
  spreadPct?: number;
  spreadRows: number;
}

/** The answer of GET /research/time-profile. */
export interface TimeProfile {
  underlying: ProfileUnderlying;
  /** the New York dates the bars cover */
  from?: string;
  to?: string;
  days: number;
  /** New York days the feed recording has quotes for (spreads are averaged over those only) */
  spreadDays: number;
  windows: WindowProfile[];
  /** every window of the latest days: high, low, range, average */
  recent: ZoneDay[];
}
