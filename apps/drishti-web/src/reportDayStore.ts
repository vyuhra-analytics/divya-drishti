import type { ClosedTrade, ManualTrade } from "@drishti/shared";

// What the trader did on a report day, kept in this browser (localStorage), one record per release: the trade they say they entered and, once they have
// exited, the closed trade with its note. Also the forecast they typed. Every read and write is guarded: private windows and blocked storage must not break
// the screen, it just forgets.

const KEY = "drishti-reportday";
const KEEP = 30;

export interface DayRecord {
  trade?: ManualTrade;
  closed?: ClosedTrade;
  /** the forecast the trader typed for this release */
  forecast?: string;
}

type Store = Record<string, DayRecord>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

export const loadRecord = (releaseAt: number): DayRecord => read()[String(releaseAt)] ?? {};

/** Merge `patch` into the release's record; the newest KEEP releases are kept. */
export function saveRecord(releaseAt: number, patch: Partial<DayRecord>): DayRecord {
  const all = read();
  const next = { ...(all[String(releaseAt)] ?? {}), ...patch };
  all[String(releaseAt)] = next;
  const keys = Object.keys(all).sort((a, b) => Number(b) - Number(a)).slice(0, KEEP);
  const kept: Store = {};
  for (const k of keys) kept[k] = all[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* storage unavailable: the record lives for this session only */
  }
  return next;
}
