// ICT killzones and the levels traders draw from them, as pure functions over candles. Everything is in New York time (daylight saving included), the
// convention these windows are quoted in. Killzones are a trading convention, not exchange rules. The study that draws them is web advKillzones.ts.
/** the candle fields these functions read, so a chart library's own bar type fits */
export type ZoneBar = { time: number; open: number; high: number; low: number; close: number };

export type ZoneId = "asian" | "london" | "nyam" | "lclose" | "nypm";

export interface Zone {
  id: ZoneId;
  label: string;
  /** minutes after midnight New York time; `to` is exclusive */
  from: number;
  to: number;
}

/** The usual windows. Variants exist (some use 08:30 to 11:00 for the New York AM); these are the common ones. */
export const ZONES: readonly Zone[] = [
  { id: "asian", label: "Asian", from: 20 * 60, to: 24 * 60 },
  { id: "london", label: "London", from: 2 * 60, to: 5 * 60 },
  { id: "nyam", label: "New York AM", from: 7 * 60, to: 10 * 60 },
  { id: "lclose", label: "London close", from: 10 * 60, to: 12 * 60 },
  { id: "nypm", label: "New York PM", from: 13 * 60 + 30, to: 16 * 60 },
];

const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** The New York calendar date (YYYY-MM-DD) and minutes after midnight of an instant (epoch seconds). */
export function nyClock(sec: number): { date: string; minutes: number } {
  const p: Record<string, string> = {};
  for (const part of NY.formatToParts(new Date(sec * 1000))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** The killzone an instant (a bar's open) falls in, or undefined. `only` limits it to the zones switched on. */
export function zoneAt(sec: number, only?: readonly ZoneId[]): ZoneId | undefined {
  const { minutes } = nyClock(sec);
  return ZONES.find((z) => (!only || only.includes(z.id)) && minutes >= z.from && minutes < z.to)?.id;
}

/** The bar length in seconds: the smallest gap between neighbouring bars (the usual one even across a session break). 0 without two bars. */
export function barSeconds(bars: readonly { time: number }[]): number {
  let best = Infinity;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].time - bars[i - 1].time;
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

export interface SessionLevels {
  /** the New York day's price at 00:00, from that moment on; null where unknown */
  midnight: (number | null)[];
  /** the high and low of the Asian window (20:00 to 24:00) that ended at that day's 00:00, shown through that whole New York day */
  asiaHigh: (number | null)[];
  asiaLow: (number | null)[];
}

/** The least of the four-hour Asian window that must be in the bars for its range to be drawn: a feed that only saw its last half hour would draw a false range. */
export const MIN_ASIAN_COVERAGE_MIN = 120;

const nextDate = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Per bar: the midnight open and the Asian range of the New York day the bar belongs to. Causal: a level appears only from the moment it is known (the
 * midnight price from 00:00, the Asian range once its window has ended), never earlier. Nothing is guessed: the midnight price needs a bar that opens
 * at 00:00 (its open) or ends at 00:00 (its close), and the Asian range needs at least two hours of bars inside its window (an MCX chart sees only the
 * last half hour of it, so it draws none).
 */
export function sessionLevels(bars: readonly ZoneBar[]): SessionLevels {
  const n = bars.length;
  const out: SessionLevels = { midnight: new Array(n).fill(null), asiaHigh: new Array(n).fill(null), asiaLow: new Array(n).fill(null) };
  const tf = barSeconds(bars);
  if (!n || !tf || tf >= 86_400) return out;
  const tfMin = tf / 60;
  const clocks = bars.map((b) => nyClock(b.time));

  const midnight = new Map<string, number>();
  const asia = new Map<string, { high: number; low: number; minutes: number }>(); // keyed by the day the range is FOR: the day after its window
  for (let i = 0; i < n; i++) {
    const { date, minutes } = clocks[i];
    if (minutes === 0) midnight.set(date, bars[i].open);
    else if (minutes === 24 * 60 - tfMin && !midnight.has(nextDate(date))) midnight.set(nextDate(date), bars[i].close);
    if (minutes >= 20 * 60) {
      const forDay = nextDate(date);
      const a = asia.get(forDay) ?? { high: -Infinity, low: Infinity, minutes: 0 };
      asia.set(forDay, { high: Math.max(a.high, bars[i].high), low: Math.min(a.low, bars[i].low), minutes: a.minutes + tfMin });
    }
  }
  for (let i = 0; i < n; i++) {
    const { date } = clocks[i];
    out.midnight[i] = midnight.get(date) ?? null;
    const a = asia.get(date);
    if (a && a.minutes >= MIN_ASIAN_COVERAGE_MIN) {
      out.asiaHigh[i] = a.high;
      out.asiaLow[i] = a.low;
    }
  }
  return out;
}
