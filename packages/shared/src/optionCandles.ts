// Which option contracts to record minute candles for, when to record them, and what to ask Upstox. Pure and tested; the recorder (API) does the I/O.
// Upstox serves one-minute candles (with open interest) for a LIVE contract only, so they must be copied while the contract lives:
// recorded after each session, they survive its expiry and give the option-price history that expired-contract APIs do not offer for MCX.
import { expiryDate, expiriesOf, pickStrikes, type OptionContract } from "./options";
import { mcxCloseMinutes } from "./sessions";

/** Crude (standard) and natural gas mini: the two instruments the owner trades options on. */
export const RECORD_UNDERLYINGS = ["CRUDEOIL", "NATGASMINI"] as const;
/** the nearest expiry and the next one: crude trades the nearest, gas the next (decided 2026-10-22) */
export const RECORD_EXPIRIES = 2;
/** strikes each side of the money, calls and puts: 11 strikes x 2 = 22 contracts per expiry */
export const RECORD_STRIKES_EACH_SIDE = 5;
/** record this long after a session closes, so the exchange's last minutes are in the candles */
export const RECORD_AFTER_CLOSE_MS = 10 * 60_000;
/** one request covers at most this many days of one-minute candles (Upstox: one month) */
export const MAX_WINDOW_DAYS = 28;

const DAY = 86_400_000;
const IST = 5.5 * 3600_000;
const istDay = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);

/**
 * The contracts to record: for each underlying, the first `expiries` expiries, and within each the strikes nearest the money
 * (by the spot of the future that expiry settles against; the middle strike when the spot is unknown), calls and puts.
 */
export function selectRecordingContracts(
  contracts: OptionContract[],
  spotByFutureKey: Record<string, number | undefined>,
  now: number,
  underlyings: readonly string[] = RECORD_UNDERLYINGS,
  expiries = RECORD_EXPIRIES,
  each = RECORD_STRIKES_EACH_SIDE,
): OptionContract[] {
  const out: OptionContract[] = [];
  for (const underlying of underlyings) {
    for (const expiry of expiriesOf(contracts, underlying, now).slice(0, expiries)) {
      const ofExpiry = contracts.filter((c) => c.underlying_symbol === underlying && expiryDate(c.expiry) === expiry);
      if (!ofExpiry.length) continue;
      const strikes = [...new Set(ofExpiry.map((c) => c.strike_price))].sort((a, b) => a - b);
      const spot = spotByFutureKey[ofExpiry[0].underlying_key] ?? strikes[Math.floor(strikes.length / 2)];
      const wanted = new Set(pickStrikes(strikes, spot, each));
      out.push(...ofExpiry.filter((c) => wanted.has(c.strike_price)));
    }
  }
  return out;
}

/** The latest MCX weekday close at or before `now` (epoch ms). Holidays are not known here: the recorder is harmless on one. */
export function lastMcxClose(now: number): number {
  const midnight = Math.floor((now + IST) / DAY) * DAY - IST; // IST midnight of today
  for (let i = 0; i <= 8; i++) {
    const start = midnight - i * DAY;
    const dow = new Date(start + IST).getUTCDay();
    if (dow < 1 || dow > 5) continue;
    const close = start + mcxCloseMinutes(start + 12 * 3600_000) * 60_000;
    if (close <= now) return close;
  }
  return midnight - 9 * DAY; // unreachable in practice
}

/** Record when a session has closed (and settled) since the last recording; a never-recorded store records at once. */
export function shouldRecord(lastRunAt: number | undefined, now: number): boolean {
  const due = lastMcxClose(now) + RECORD_AFTER_CLOSE_MS;
  return now >= due && (lastRunAt === undefined || lastRunAt < due);
}

/** IST dates to ask for: from the day of the last recording (or three days back) to today, never longer than one request allows. */
export function recordingWindow(lastRunAt: number | undefined, now: number): { from: string; to: string } {
  const from = Math.max(lastRunAt === undefined ? now - 3 * DAY : lastRunAt - DAY, now - MAX_WINDOW_DAYS * DAY);
  return { from: istDay(from), to: istDay(now) };
}

/** One contract's one-minute candles between two IST dates (inclusive). */
export const optionCandlesUrl = (key: string, from: string, to: string) =>
  `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/minutes/1/${to}/${from}`;

/**
 * Today's one-minute candles of a contract. Upstox's dated endpoint never includes the current day, so a recording made after the close
 * would miss the very session it is for (and a strike that drifts out of the selection overnight would lose it for good): the session is
 * copied from this endpoint, the earlier days from the dated one.
 */
export const optionIntradayUrl = (key: string) => `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(key)}/minutes/1`;
