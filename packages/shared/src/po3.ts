// ICT "Power of 3" (accumulation, manipulation, distribution) reduced to one mechanical rule that can be counted: the Asian window (20:00 to 24:00 New York
// time) sets a range; in the London killzone (02:00 to 05:00) price takes out one side of it (the sweep: a wick or a close beyond the level) and a bar then
// closes back inside the range (the confirmation). A swept high that closes back inside is the bearish setup, a swept low the bullish one. The marker
// sits on the confirming bar, so it never knows more than that bar knew; what happened afterwards is measured separately (`po3Outcome`), for counting,
// never for drawing. The trader's own reading of the three phases is judgement; this rule is only the part a machine can state. Pure and tested.
import { LONDON_OPEN_WINDOW, londonClock, nyClock, sessionLevels, type ZoneBar } from "./sessionZones";

export type Po3Bias = "bullish" | "bearish";

export interface Po3Event {
  /** the New York date of the London session */
  day: string;
  bias: Po3Bias;
  /** which side of the Asian range was taken out */
  side: "high" | "low";
  rangeHigh: number;
  rangeLow: number;
  /** the bar that first went beyond the level, and the bar that closed back inside (epoch seconds; they can be the same bar) */
  sweepAt: number;
  confirmAt: number;
  /** index of the confirming bar in the bars given */
  confirmIndex: number;
  /** the furthest price beyond the level reached before the confirmation */
  extreme: number;
}

export interface Po3Options {
  /** bars after the sweep within which a close back inside confirms it (default 6) */
  confirmBars?: number;
  /** read the London killzone as London's 07:00 to 10:00 instead of New York's 02:00 to 05:00 */
  londonOpen?: boolean;
}

const LONDON = { from: 2 * 60, to: 5 * 60 };
/** a confirmation must come before the New York AM killzone opens */
const CONFIRM_BY = 7 * 60;

/**
 * Every sweep-and-reverse of the Asian range in the London killzone: at most one per New York day (the first sweep). A bar that takes out both sides, or
 * a sweep that is followed by the other side being taken out before a close back inside, is not an event (it is a breakout, or noise).
 */
export function po3Sweeps(bars: readonly ZoneBar[], opts: Po3Options = {}): Po3Event[] {
  const confirmBars = opts.confirmBars ?? 6;
  const lv = sessionLevels(bars);
  const clocks = bars.map((b) => nyClock(b.time));
  const out: Po3Event[] = [];
  const done = new Set<string>();

  for (let i = 0; i < bars.length; i++) {
    const { date, minutes } = clocks[i];
    const H = lv.asiaHigh[i];
    const L = lv.asiaLow[i];
    const ldn = opts.londonOpen ? londonClock(bars[i].time).minutes : 0;
    const inLondon = opts.londonOpen ? ldn >= LONDON_OPEN_WINDOW.from && ldn < LONDON_OPEN_WINDOW.to : minutes >= LONDON.from && minutes < LONDON.to;
    if (done.has(date) || H === null || L === null || !inLondon) continue;
    const up = bars[i].high > H;
    const down = bars[i].low < L;
    if (!up && !down) continue;
    done.add(date); // the first breach decides the day, whatever comes of it
    if (up && down) continue; // both sides in one bar: no direction
    const side = up ? "high" : "low";
    let extreme = up ? bars[i].high : bars[i].low;
    for (let j = i; j < bars.length && j <= i + confirmBars; j++) {
      if (clocks[j].date !== date || clocks[j].minutes >= CONFIRM_BY) break;
      const b = bars[j];
      if (side === "high" ? b.low < L : b.high > H) break; // the other side went too: a breakout, not a sweep
      extreme = side === "high" ? Math.max(extreme, b.high) : Math.min(extreme, b.low);
      const inside = side === "high" ? b.close < H : b.close > L;
      if (inside) {
        out.push({ day: date, bias: side === "high" ? "bearish" : "bullish", side, rangeHigh: H, rangeLow: L, sweepAt: bars[i].time, confirmAt: b.time, confirmIndex: j, extreme });
        break;
      }
    }
  }
  return out;
}

export interface Po3Outcome {
  /** price traded to the OTHER side of the Asian range (the low after a swept high, the high after a swept low) between the confirmation and 12:00 New York time */
  reachedOpposite: boolean;
  /** the furthest move in the setup's direction after the confirming close, as a share of the Asian range's height */
  favourableRange: number;
}

/** What followed one event, for counting. Looks at bars AFTER the confirming bar until 12:00 on the same New York day. */
export function po3Outcome(bars: readonly ZoneBar[], e: Po3Event): Po3Outcome {
  const height = e.rangeHigh - e.rangeLow;
  const close = bars[e.confirmIndex].close;
  let best = 0;
  let reached = false;
  for (let j = e.confirmIndex + 1; j < bars.length; j++) {
    const c = nyClock(bars[j].time);
    if (c.date !== e.day || c.minutes >= 12 * 60) break;
    if (e.bias === "bearish") {
      best = Math.max(best, close - bars[j].low);
      if (bars[j].low <= e.rangeLow) reached = true;
    } else {
      best = Math.max(best, bars[j].high - close);
      if (bars[j].high >= e.rangeHigh) reached = true;
    }
  }
  return { reachedOpposite: reached, favourableRange: height > 0 ? best / height : 0 };
}

export interface Po3Stats {
  /** New York days with a known Asian range and a London session in the bars */
  days: number;
  events: number;
  bullish: number;
  bearish: number;
  /** events after which price reached the other side of the range by 12:00 */
  reached: number;
  /** the same share on the days with a range but no event: how often price touched the low, and the high, between 05:00 and 12:00 (the comparison that matters) */
  baselineLow: number | undefined;
  baselineHigh: number | undefined;
}

/** How often the setup appears and how often it is followed through, against the same measure on days without it. */
export function po3Stats(bars: readonly ZoneBar[], opts: Po3Options = {}): Po3Stats {
  const events = po3Sweeps(bars, opts);
  const lv = sessionLevels(bars);
  const clocks = bars.map((b) => nyClock(b.time));
  const eventDays = new Set(events.map((e) => e.day));
  const perDay = new Map<string, { low: boolean; high: boolean; H: number; L: number }>();
  const days = new Set<string>();
  for (let i = 0; i < bars.length; i++) {
    const { date, minutes } = clocks[i];
    const H = lv.asiaHigh[i];
    const L = lv.asiaLow[i];
    if (H === null || L === null) continue;
    if (minutes >= LONDON.from && minutes < LONDON.to) days.add(date);
    if (eventDays.has(date) || minutes < 5 * 60 || minutes >= 12 * 60) continue;
    const d = perDay.get(date) ?? { low: false, high: false, H, L };
    if (bars[i].low <= L) d.low = true;
    if (bars[i].high >= H) d.high = true;
    perDay.set(date, d);
  }
  const outcomes = events.map((e) => po3Outcome(bars, e));
  const base = [...perDay.values()];
  return {
    days: days.size,
    events: events.length,
    bullish: events.filter((e) => e.bias === "bullish").length,
    bearish: events.filter((e) => e.bias === "bearish").length,
    reached: outcomes.filter((o) => o.reachedOpposite).length,
    baselineLow: base.length ? base.filter((d) => d.low).length / base.length : undefined,
    baselineHigh: base.length ? base.filter((d) => d.high).length / base.length : undefined,
  };
}
