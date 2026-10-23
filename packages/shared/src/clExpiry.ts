// NYMEX light sweet crude (CL) contract expiry dates, for the sentiment study (deviation D2): Yahoo's CL=F is a spliced continuous series, so a forward-return
// window that touches a contract roll mixes two contracts and is dropped. Rule: trading ends 3 business days before the 25th calendar day of the month before
// the delivery month; if the 25th is not a business day, 3 business days before the business day before it. US exchange holidays as listed below.

const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m, d);
const dow = (ms: number) => new Date(ms).getUTCDay();

/** Easter Sunday (anonymous Gregorian algorithm), for Good Friday. */
function easter(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/** The n-th weekday (0 Sunday) of a month, or the last one when n is -1. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n === -1) {
    let d = utc(year, month + 1, 0);
    while (dow(d) !== weekday) d -= DAY;
    return d;
  }
  let d = utc(year, month, 1);
  while (dow(d) !== weekday) d += DAY;
  return d + (n - 1) * 7 * DAY;
}

/** A holiday that falls on a Saturday is observed on the Friday, on a Sunday on the Monday. */
const observed = (d: number) => (dow(d) === 6 ? d - DAY : dow(d) === 0 ? d + DAY : d);

/** The days the exchange is closed in a year: New Year, Martin Luther King, Presidents, Good Friday, Memorial, Juneteenth, Independence, Labor, Thanksgiving, Christmas. */
export function usHolidays(year: number): Set<number> {
  return new Set([
    observed(utc(year, 0, 1)),
    nthWeekday(year, 0, 1, 3),
    nthWeekday(year, 1, 1, 3),
    easter(year) - 2 * DAY,
    nthWeekday(year, 4, 1, -1),
    observed(utc(year, 5, 19)),
    observed(utc(year, 6, 4)),
    nthWeekday(year, 8, 1, 1),
    nthWeekday(year, 10, 4, 4),
    observed(utc(year, 11, 25)),
  ]);
}

function isBusinessDay(ms: number): boolean {
  const d = dow(ms);
  if (d === 0 || d === 6) return false;
  const y = new Date(ms).getUTCFullYear();
  return !usHolidays(y).has(ms) && !usHolidays(y + 1).has(ms); // next year's list covers a 1 January observed on 31 December
}

const stepBack = (from: number, n: number) => {
  let d = from;
  while (n > 0) {
    d -= DAY;
    if (isBusinessDay(d)) n--;
  }
  return d;
};

/** The last trading day (UTC midnight of that date) of the CL contract that delivers in `month` (0-based) of `year`. */
export function clExpiry(year: number, month: number): number {
  const m = month === 0 ? 11 : month - 1;
  const y = month === 0 ? year - 1 : year;
  let base = utc(y, m, 25);
  while (!isBusinessDay(base)) base -= DAY;
  return stepBack(base, 3);
}

/** Every expiry within three days of [from, to] (UTC ms), one per delivery month, oldest first. */
export function clExpiries(from: number, to: number): number[] {
  const out: number[] = [];
  const a = new Date(from);
  let y = a.getUTCFullYear();
  let m = a.getUTCMonth();
  for (let i = 0; i < 400; i++) {
    const e = clExpiry(y, m);
    if (e > to + 3 * DAY) break;
    if (e >= from - 3 * DAY) out.push(e);
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

/**
 * Whether a window [start, end] (UTC ms) touches a roll: from one day before an expiry to two days after it (the expiry is a date; the splice in the
 * continuous series happens around its close). Used to drop a forward-return window that spans two contracts.
 */
export function touchesRoll(start: number, end: number, expiries: number[]): boolean {
  return expiries.some((e) => start <= e + 3 * DAY && end >= e - DAY);
}
