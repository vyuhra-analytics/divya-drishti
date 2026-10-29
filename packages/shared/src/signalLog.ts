// The signal log: what the report-day and USIB rules did on a given evening, decided from the CLOSED candles only, as a record that can be stored. The same
// pure functions the screens use (watchWindow, watchUsib) are run once the entry window is over, so the log shows exactly what the screen showed. Whether the
// trader took the signal is not recorded here: trades are joined on at read time. Pure and tested; nothing here places an order.
import { zonedTime } from "./eventSeries";
import { DAY_RULES, preReleaseRange, REPORT_DAY, watchWindow, type DayBar, type DaySide, type ReportCode } from "./reportDay";
import { usibRange, USIB_RULES, watchUsib, type UsibBar } from "./usib";

export type SignalStatus = "signal" | "no_signal" | "no_range" | "no_bars" | "skipped";

export interface LoggedCandle {
  /** the candle's open, epoch seconds */
  time: number;
  close: number;
  state: "inside" | "above" | "below";
  /** report day: closed beyond the range against the surprise; USIB: why a break was filtered */
  note?: string;
  /** USIB: volume as a multiple of the ten candles before it, and the session VWAP at its close */
  volumeRatio?: number;
  vwap?: number;
}

export interface LoggedSignal {
  side: DaySide;
  /** the candle that closed beyond the range (its open) and when it closed, epoch seconds */
  candleTime: number;
  closedAt: number;
  entry?: number;
  rPoints?: number;
  stop?: number;
  tp1?: number;
  tp2?: number;
  tp2Source?: string;
  trail?: number;
}

export interface SignalRecord {
  /** the same evening and market always give the same key, so a second evaluation is recognised and dropped */
  key: string;
  strategy: "report-day" | "usib";
  symbol: string;
  /** the print (report day) or the US cash open (USIB), epoch ms */
  at: number;
  status: SignalStatus;
  /** why there was no signal, or what was missing */
  reason?: string;
  /** report day: which report, the number against the forecast and the side it allowed */
  report?: { code: ReportCode; change?: number; forecast?: number; forecastSource?: string; surprise?: number; threshold: number; side: DaySide | "none" };
  range?: { high: number; low: number; width: number; candles: number };
  candles: LoggedCandle[];
  skippedAgainst?: number;
  signal?: LoggedSignal;
  /** the cut-off for entries, epoch seconds */
  cutoffAt?: number;
  /** what the rules could not use after the fact, in words (e.g. USIB's TP2 chain levels) */
  notes: string[];
}

export const reportKey = (code: ReportCode, releaseAt: number) => `report-day:${code}:${releaseAt}`;
export const usibKey = (symbol: string, openAt: number) => `usib:${symbol}:${openAt}`;

export interface ReportDayInput {
  code: ReportCode;
  releaseAt: number;
  bars: readonly DayBar[];
  change?: number;
  forecast?: number;
  forecastSource?: string;
  surprise?: number;
  side: DaySide | "none";
}

const toSignal = (s: LoggedSignal): LoggedSignal => ({
  side: s.side,
  candleTime: s.candleTime,
  closedAt: s.closedAt,
  entry: s.entry,
  rPoints: s.rPoints,
  stop: s.stop,
  tp1: s.tp1,
  tp2: s.tp2,
  ...(s.tp2Source ? { tp2Source: s.tp2Source } : {}),
  ...(s.trail !== undefined ? { trail: s.trail } : {}),
});

/** One report day, judged at the end of its entry window: the hour-before range, every candle of the window, and the first entry (if any). */
export function evaluateReportDay(i: ReportDayInput): SignalRecord {
  const cfg = REPORT_DAY[i.code];
  const releaseSec = i.releaseAt / 1000;
  const cutoffAt = releaseSec + DAY_RULES.cutoffMin * 60;
  const base: SignalRecord = {
    key: reportKey(i.code, i.releaseAt),
    strategy: "report-day",
    symbol: cfg.symbol,
    at: i.releaseAt,
    status: "no_bars",
    cutoffAt,
    candles: [],
    notes: [],
    report: { code: i.code, change: i.change, forecast: i.forecast, forecastSource: i.forecastSource, surprise: i.surprise, threshold: cfg.threshold, side: i.side },
  };
  if (!i.bars.length) return { ...base, reason: "no 5-minute candles for the day" };
  const range = preReleaseRange(i.bars, releaseSec, cutoffAt);
  if (!range) return { ...base, status: "no_range", reason: "no candles in the hour before the print" };
  const notes: string[] = [];
  if (!range.complete) notes.push(`the range hour is only partly covered (${range.candles} candles)`);
  if (i.forecast === undefined) notes.push("no forecast was on record: the number set no side, a range break alone could trade");
  const watch = watchWindow(i.bars, releaseSec, range, i.side === "none" ? undefined : i.side, cutoffAt);
  const candles: LoggedCandle[] = watch.candles.map((c) => ({ time: c.time, close: c.close, state: c.state, ...(c.against ? { note: "against the surprise" } : {}) }));
  const out: SignalRecord = { ...base, range: { high: range.high, low: range.low, width: range.width, candles: range.candles }, candles, skippedAgainst: watch.skippedAgainst, notes };
  if (watch.signal) return { ...out, status: "signal", signal: toSignal(watch.signal) };
  const reason = !watch.candles.length ? "no candles in the window" : watch.skippedAgainst ? `${watch.skippedAgainst} close${watch.skippedAgainst === 1 ? "" : "s"} beyond the range, all against the surprise` : "no 5-minute close beyond the range in the window";
  return { ...out, status: "no_signal", reason };
}

export interface UsibInput {
  /** the instrument the candles are of, e.g. MCX:CRUDEOIL */
  symbol: string;
  openAt: number;
  bars: readonly UsibBar[];
}

/** One USIB evening, judged at the end of its entry window. The chain at the open is not available afterwards, so TP2 falls back to 2R (said in the notes). */
export function evaluateUsib(i: UsibInput): SignalRecord {
  const openSec = i.openAt / 1000;
  const cutoffAt = openSec + USIB_RULES.entryWindowMin * 60;
  const base: SignalRecord = { key: usibKey(i.symbol, i.openAt), strategy: "usib", symbol: i.symbol, at: i.openAt, status: "no_bars", cutoffAt, candles: [], notes: ["TP2 uses the 2R default: the option chain at the open is not available afterwards"] };
  if (!i.bars.length) return { ...base, reason: "no 5-minute candles for the evening" };
  const range = usibRange(i.bars, openSec, cutoffAt);
  if (!range) return { ...base, status: "no_range", reason: "no candles in the hour before the open" };
  const watch = watchUsib(i.bars, openSec, range, [], cutoffAt);
  const candles: LoggedCandle[] = watch.candles.map((c) => ({
    time: c.time,
    close: c.close,
    state: c.state,
    ...(c.filtered ? { note: c.filtered } : {}),
    ...(c.volumeRatio !== undefined ? { volumeRatio: Math.round(c.volumeRatio * 100) / 100 } : {}),
    ...(c.vwap !== undefined ? { vwap: Math.round(c.vwap * 100) / 100 } : {}),
  }));
  const out: SignalRecord = { ...base, range: { high: range.high, low: range.low, width: range.width, candles: range.candles }, candles };
  if (watch.signal) return { ...out, status: "signal", signal: toSignal(watch.signal) };
  const filtered = watch.candles.filter((c) => c.filtered).length;
  return {
    ...out,
    status: "no_signal",
    reason: !watch.candles.length ? "no candles in the entry window" : filtered ? `${filtered} break${filtered === 1 ? "" : "s"} beyond the range failed the volume or VWAP filter` : "no 5-minute close beyond the range in the entry window",
  };
}

/** A day that is logged as skipped, with the reason (e.g. USIB on an EIA report day). */
export const skippedRecord = (strategy: "report-day" | "usib", key: string, symbol: string, at: number, reason: string): SignalRecord => ({ key, strategy, symbol, at, status: "skipped", reason, candles: [], notes: [] });

const nyDate = (ms: number) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { y: Number(g("year")), m: Number(g("month")) - 1, d: Number(g("day")), wd: g("weekday"), iso: `${g("year")}-${g("month")}-${g("day")}` };
};
/** New York calendar date (YYYY-MM-DD) of a moment: how a USIB evening is matched to an EIA report day. */
export const nyDay = (ms: number) => nyDate(ms).iso;

/** The US cash opens (09:30 New York, weekdays, daylight saving followed) that have happened in the last `days` days, oldest first. Holidays are not known: the candles decide. */
export function recentUsOpens(now: number, days: number): number[] {
  const out: number[] = [];
  const seen = new Set<string>();
  for (let k = days - 1; k >= 0; k--) {
    const n = nyDate(now - k * 86_400_000);
    if (n.wd === "Sat" || n.wd === "Sun" || seen.has(n.iso)) continue;
    seen.add(n.iso);
    const at = zonedTime("America/New_York", n.y, n.m, n.d, 9, 30);
    if (at <= now) out.push(at);
  }
  return out;
}

/** Has the entry window of a strategy's evening closed, with a few minutes for the last candle to arrive? */
export const windowClosed = (strategy: "report-day" | "usib", at: number, now: number) => now >= at + ((strategy === "report-day" ? DAY_RULES.cutoffMin : USIB_RULES.entryWindowMin) + 3) * 60_000;
