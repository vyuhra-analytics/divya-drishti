// The evening's clock: what comes next and when, from the US open, the EIA print and the MCX close, so a one-line strip can say it on every desk.
// Pure and tested; the strip is web DayStrip.tsx.
import { usOpenFor, USIB_RULES } from "./usib";
import { DAY_RULES } from "./reportDay";
import { TIME_STOP } from "./reportTrade";

export interface ClockEvent {
  at: number;
  label: string;
}

export interface ClockInput {
  /** the next EIA print (epoch ms), if one is scheduled */
  printAt?: number;
  /** when MCX closes tonight, if it is open (epoch ms) */
  mcxCloseAt?: number;
}

const MIN = 60_000;

/** Every marked moment from now to `horizonH` hours on, oldest first. */
export function eveningEvents(now: number, input: ClockInput = {}, horizonH = 24): ClockEvent[] {
  const open = usOpenFor(now);
  // an EIA report on the open's day is the day's trade: the USIB marks are left out then
  const nyDate = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(t);
  const reportDay = input.printAt !== undefined && nyDate(input.printAt) === nyDate(open);
  const all: ClockEvent[] = reportDay
    ? []
    : [
        { at: open - USIB_RULES.rangeMin * MIN, label: "USIB range hour starts" },
        { at: open, label: "US open: the USIB range is set" },
        { at: open + USIB_RULES.entryWindowMin * MIN, label: "USIB entry window closes" },
        { at: open + USIB_RULES.timeStopFromMin * MIN, label: "USIB time stop window opens" },
      ];
  if (input.printAt !== undefined) {
    all.push(
      { at: input.printAt - DAY_RULES.rangeMin * MIN, label: "EIA range hour starts" },
      { at: input.printAt, label: "EIA print" },
      { at: input.printAt + DAY_RULES.cutoffMin * MIN, label: "EIA entry window closes" },
      { at: input.printAt + TIME_STOP.fromMin * MIN, label: "EIA time stop window opens" },
    );
  }
  if (input.mcxCloseAt !== undefined) all.push({ at: input.mcxCloseAt, label: "MCX closes" });
  return all.filter((e) => e.at > now && e.at <= now + horizonH * 3600 * 1000).sort((a, b) => a.at - b.at);
}

/** "in 23m", "in 1h 05m", "in 0:42" for under a minute. */
export function inText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `in 0:${String(s).padStart(2, "0")}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `in ${h}h ${String(m).padStart(2, "0")}m` : `in ${m}m`;
}
