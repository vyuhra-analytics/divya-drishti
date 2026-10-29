import { parseSymbol, type DayResult } from "./family";
import type { ClosedLot } from "./fifo";

// Risk figures and habit patterns from the exact trading days and the closed positions of the dated tradebooks. Descriptive only: they say what happened, not what to
// do, and a row with few observations is marked thin so nobody reads a pattern into five trades.

/** Rows with fewer observations than this are shown but marked thin. */
export const THIN = 5;

export interface DayRisk {
  days: number;
  winDays: number;
  lossDays: number;
  bestDay: DayResult;
  worstDay: DayResult;
  /** the run the latest day belongs to: consecutive trading days with a gain, or with a loss */
  streak: { kind: "win" | "loss" | "flat"; days: number };
  /** the deepest fall of the running net from its peak (the start counts as a peak of zero); `from` is null when the peak is the start */
  maxDrawdown: { amount: number; from: string | null; to: string };
  /** how far the running net is now below its peak (0 at a new high) */
  currentDrawdown: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function dayRisk(days: DayResult[]): DayRisk | null {
  if (days.length === 0) return null;
  let best = days[0];
  let worst = days[0];
  let cum = 0;
  let peak = 0;
  let peakDate: string | null = null;
  let dd = { amount: 0, from: null as string | null, to: days[0].date };
  for (const d of days) {
    if (d.net > best.net) best = d;
    if (d.net < worst.net) worst = d;
    cum += d.net;
    if (cum > peak) {
      peak = cum;
      peakDate = d.date;
    }
    if (peak - cum > dd.amount) dd = { amount: r2(peak - cum), from: peakDate, to: d.date };
  }
  const sign = (n: number) => (n > 0 ? "win" : n < 0 ? "loss" : "flat");
  const kind = sign(days[days.length - 1].net);
  let run = 0;
  for (let i = days.length - 1; i >= 0 && sign(days[i].net) === kind; i--) run++;
  return {
    days: days.length,
    winDays: days.filter((d) => d.net > 0).length,
    lossDays: days.filter((d) => d.net < 0).length,
    bestDay: best,
    worstDay: worst,
    streak: { kind, days: run },
    maxDrawdown: dd,
    currentDrawdown: r2(peak - cum),
  };
}

export interface HabitRow {
  label: string;
  /** observations: closed positions, or trading days for the busy-day table */
  n: number;
  /** the realised result (before charges) of those positions, or the net of those days */
  total: number;
  avg: number;
  /** the share with a gain, 0 to 1 */
  winRate: number;
  thin: boolean;
}

export interface Habits {
  /** closed positions in the sample, and the trading days */
  positions: number;
  days: number;
  /** by the weekday a position was closed */
  weekday: HabitRow[];
  /** by how long it was held */
  hold: HabitRow[];
  /** by what was traded: bought or sold, calls, puts, futures */
  kind: HabitRow[];
  /** by how many positions were closed in the day, the day's net after charges */
  busy: HabitRow[];
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

function rows(groups: Map<string, number[]>, order: string[]): HabitRow[] {
  return order
    .filter((label) => groups.has(label))
    .map((label) => {
      const v = groups.get(label)!;
      const total = v.reduce((a, x) => a + x, 0);
      return { label, n: v.length, total: r2(total), avg: r2(total / v.length), winRate: v.filter((x) => x > 0).length / v.length, thin: v.length < THIN };
    });
}
function push(m: Map<string, number[]>, key: string, v: number) {
  const list = m.get(key) ?? [];
  list.push(v);
  m.set(key, list);
}

export function habits(lots: ClosedLot[], days: DayResult[]): Habits | null {
  if (lots.length === 0) return null;
  const weekday = new Map<string, number[]>();
  const hold = new Map<string, number[]>();
  const kind = new Map<string, number[]>();
  for (const l of lots) {
    push(weekday, WEEKDAYS[new Date(`${l.closeDate}T00:00:00Z`).getUTCDay()], l.pnl);
    const held = dayNumber(l.closeDate) - dayNumber(l.openDate);
    push(hold, held <= 0 ? "Same day" : held <= 2 ? "1 to 2 days" : "3 days or more", l.pnl);
    const s = parseSymbol(l.symbol);
    const what = s.kind === "option" ? (s.optionType === "CE" ? "calls" : "puts") : s.kind === "future" ? "futures" : "other";
    push(kind, `${l.direction === "long" ? "Bought" : "Sold"} ${what}`, l.pnl);
  }
  const busy = new Map<string, number[]>();
  for (const d of days) if (d.closes > 0) push(busy, d.closes <= 2 ? "1 to 2 positions closed" : d.closes <= 5 ? "3 to 5 positions closed" : "6 or more closed", d.net);
  return {
    positions: lots.length,
    days: days.filter((d) => d.closes > 0).length,
    weekday: rows(weekday, WEEKDAYS.slice(1).concat(WEEKDAYS[0])),
    hold: rows(hold, ["Same day", "1 to 2 days", "3 days or more"]),
    kind: rows(kind, ["Bought calls", "Bought puts", "Sold calls", "Sold puts", "Bought futures", "Sold futures", "Bought other", "Sold other"]),
    busy: rows(busy, ["1 to 2 positions closed", "3 to 5 positions closed", "6 or more closed"]),
  };
}
