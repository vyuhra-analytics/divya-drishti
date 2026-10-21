// Exchange trading sessions for our instruments. Pure (clock passed in) so boundaries are unit-tested.
import { tzOffsetSec } from "./index";

export interface SessionState {
  open: boolean;
  /** epoch ms of the next open/close boundary, if known */
  next?: number;
}

/** Upstox's official MCX window for one day (from /v2/market/timings and /holidays), or "closed" for a holiday. */
export type DayOverride = { start: number; end: number } | "closed";

const H = 3600_000;
const MIN = 60_000;

/** Wall-clock parts of an instant in a zone, plus a converter back from that zone's local midnight. */
function local(now: number, tz: string) {
  const off = tzOffsetSec(tz, now) * 1000;
  const d = new Date(now + off);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off; // local 00:00 as epoch ms
  return { dow: d.getUTCDay(), msOfDay: now + off - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), midnight };
}

/** US daylight saving decides MCX's close: commodities follow US hours (23:30 IST in summer, 23:55 in winter). */
export const mcxCloseMinutes = (now: number) => (tzOffsetSec("America/New_York", now) === -4 * 3600 ? 23 * 60 + 30 : 23 * 60 + 55);

/**
 * MCX energy: Mon–Fri 09:00 IST to 23:30/23:55 IST. `today` (Upstox calendar) overrides the rule for the current
 * IST day, e.g. holidays or special sessions. Without it, exchange holidays aren't known.
 */
export function mcxSession(now: number, today?: DayOverride): SessionState {
  const { dow, midnight } = local(now, "Asia/Kolkata");
  let start = midnight + 9 * H;
  let end = midnight + mcxCloseMinutes(now) * MIN;
  const weekday = dow >= 1 && dow <= 5;
  if (today === "closed" || (!today && !weekday)) return { open: false, next: nextMcxOpen(midnight) };
  if (today) ({ start, end } = today); // "closed" already returned above
  if (now < start) return { open: false, next: start };
  if (now < end) return { open: true, next: end };
  return { open: false, next: nextMcxOpen(midnight) };
}

/** 09:00 IST of the next weekday after the IST day starting at `midnight` (holidays unknown here). */
function nextMcxOpen(midnight: number): number {
  for (let d = 1; d <= 7; d++) {
    const day = midnight + d * 24 * H;
    const dow = new Date(day + 5.5 * H).getUTCDay();
    if (dow >= 1 && dow <= 5) return day + 9 * H;
  }
  return midnight + 24 * H + 9 * H;
}

/**
 * NYMEX energy on CME Globex: Sunday 18:00 ET to Friday 17:00 ET, with a daily 17:00–18:00 ET maintenance break.
 * ponytail: US exchange holidays aren't modelled (early closes show as open); add a CME calendar if it matters.
 */
export function nymexSession(now: number): SessionState {
  const { dow, msOfDay, midnight } = local(now, "America/New_York");
  const at = (h: number, dayOffset = 0) => midnight + dayOffset * 24 * H + h * H;
  const mins = msOfDay / MIN;
  if (dow === 6) return { open: false, next: at(18, 1) }; // Saturday → Sunday 18:00
  if (dow === 0) return mins < 18 * 60 ? { open: false, next: at(18) } : { open: true, next: at(17, 1) };
  if (dow === 5) return mins < 17 * 60 ? { open: true, next: at(17) } : { open: false, next: at(18, 2) };
  // Mon–Thu: open except 17:00–18:00
  if (mins < 17 * 60) return { open: true, next: at(17) };
  if (mins < 18 * 60) return { open: false, next: at(18) };
  return { open: true, next: at(17, 1) };
}

export type Freshness = "live" | "stale" | "closed";

/**
 * Is a quote trustworthy right now? Closed when the exchange is shut; stale when it's open but the serving source
 * hasn't been heard from for `staleAfterMs` (heard = any poll/feed message, not just a price change).
 */
export function freshness(sessionOpen: boolean, lastHeardAt: number | undefined, now: number, staleAfterMs = 60_000): Freshness {
  if (!sessionOpen) return "closed";
  return lastHeardAt !== undefined && now - lastHeardAt <= staleAfterMs ? "live" : "stale";
}
