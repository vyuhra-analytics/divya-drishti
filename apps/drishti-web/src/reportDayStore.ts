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

export const loadRecord = (key: number | string): DayRecord => read()[String(key)] ?? {};

/** Merge `patch` into the record of a release (epoch ms) or a USIB day ("usib:" + epoch ms); the newest KEEP are kept. */
export function saveRecord(key: number | string, patch: Partial<DayRecord>): DayRecord {
  const all = read();
  const next = { ...(all[String(key)] ?? {}), ...patch };
  all[String(key)] = next;
  // newest first: the keys are epoch ms or "usib:" followed by one
  const stamp = (k: string) => Number(k.replace(/^\D+/, ""));
  const keys = Object.keys(all).sort((a, b) => stamp(b) - stamp(a)).slice(0, KEEP);
  const kept: Store = {};
  for (const k of keys) kept[k] = all[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* storage unavailable: the record lives for this session only */
  }
  return next;
}
