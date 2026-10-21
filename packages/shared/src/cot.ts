// CFTC Commitments of Traders (disaggregated, futures only): who holds the open interest in WTI, Brent, RBOB and Henry Hub.
// Weekly: positions as of Tuesday, published the Friday after (15:30 New York). Free, keyless Socrata API.
// Pure parsing and statistics, tested against a real response.

export const COT_DATASET = "72hh-3qpy"; // disaggregated, futures only

/** The energy contracts we show, with the CFTC contract market code. Brent here is NYMEX's "last day" contract. */
export const COT_MARKETS = [
  { id: "wti", code: "067651", name: "WTI crude oil (NYMEX)", ours: ["NYMEX:CL", "MCX:CRUDEOIL", "MCX:CRUDEOILM"] },
  { id: "brent", code: "06765T", name: "Brent (NYMEX last day)", ours: [] },
  { id: "natgas", code: "023651", name: "Natural gas, Henry Hub (NYMEX)", ours: ["NYMEX:NG", "MCX:NATURALGAS", "MCX:NATGASMINI"] },
  { id: "rbob", code: "111659", name: "RBOB gasoline (NYMEX)", ours: [] },
] as const;
export type CotMarketId = (typeof COT_MARKETS)[number]["id"];

export interface CotGroup {
  long: number;
  short: number;
  /** long minus short */
  net: number;
  /** week-over-week change in long and short (spread excluded) */
  changeLong?: number;
  changeShort?: number;
  /** traders in the group on each side, where the CFTC reports it */
  tradersLong?: number;
  tradersShort?: number;
}

export interface CotRow {
  /** report date (Tuesday), UTC midnight, epoch ms */
  date: number;
  openInterest: number;
  openInterestChange?: number;
  /** speculators: hedge funds and commodity trading advisors */
  managedMoney: CotGroup & { spread: number };
  /** physical producers, merchants, processors and users: the hedgers */
  producers: CotGroup;
  swapDealers: CotGroup;
  otherReportable: CotGroup;
  /** small traders below the reporting limit */
  nonReportable: CotGroup;
}

const n = (v: unknown): number | undefined => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : undefined;
};
const group = (r: any, long: string, short: string, cl?: string, cs?: string, tl?: string, ts?: string): CotGroup | undefined => {
  const l = n(r[long]);
  const s = n(r[short]);
  return l === undefined || s === undefined ? undefined : { long: l, short: s, net: l - s, changeLong: cl ? n(r[cl]) : undefined, changeShort: cs ? n(r[cs]) : undefined, tradersLong: tl ? n(r[tl]) : undefined, tradersShort: ts ? n(r[ts]) : undefined };
};

/** Socrata rows → CFTC rows, oldest first. Rows missing the open interest or any main group are skipped. */
export function parseCot(rows: any[]): CotRow[] {
  const out: CotRow[] = [];
  for (const r of rows ?? []) {
    const date = Date.parse(`${String(r.report_date_as_yyyy_mm_dd).slice(0, 10)}T00:00:00Z`);
    const oi = n(r.open_interest_all);
    const mm = group(r, "m_money_positions_long_all", "m_money_positions_short_all", "change_in_m_money_long_all", "change_in_m_money_short_all", "traders_m_money_long_all", "traders_m_money_short_all");
    const prod = group(r, "prod_merc_positions_long", "prod_merc_positions_short", "change_in_prod_merc_long", "change_in_prod_merc_short", "traders_prod_merc_long_all", "traders_prod_merc_short_all");
    const swap = group(r, "swap_positions_long_all", "swap__positions_short_all", "change_in_swap_long_all", "change_in_swap_short_all", "traders_swap_long_all", "traders_swap_short_all");
    const other = group(r, "other_rept_positions_long", "other_rept_positions_short", "change_in_other_rept_long", "change_in_other_rept_short", "traders_other_rept_long_all", "traders_other_rept_short");
    const small = group(r, "nonrept_positions_long_all", "nonrept_positions_short_all", "change_in_nonrept_long_all", "change_in_nonrept_short_all");
    if (!Number.isFinite(date) || oi === undefined || !mm || !prod || !swap || !other || !small) continue;
    out.push({ date, openInterest: oi, openInterestChange: n(r.change_in_open_interest_all), managedMoney: { ...mm, spread: n(r.m_money_positions_spread) ?? 0 }, producers: prod, swapDealers: swap, otherReportable: other, nonReportable: small });
  }
  return out.sort((a, b) => a.date - b.date);
}

/** Week-over-week change in a group's net position (long change minus short change). */
export const netChange = (g: CotGroup) => (g.changeLong !== undefined && g.changeShort !== undefined ? g.changeLong - g.changeShort : undefined);

/** Share of values in `history` at or below `value`, 0 to 100: where today's positioning sits against its own past. */
export function percentileRank(value: number, history: number[]): number | undefined {
  if (history.length < 10) return undefined;
  return (history.filter((v) => v <= value).length / history.length) * 100;
}

/** When a report dated `date` (a Tuesday) is published: the Friday after at 15:30 New York time (19:30 UTC in summer, 20:30 in winter: approximated at 19:30 UTC). */
export const cotPublishedAt = (date: number) => date + 3 * 86_400_000 + 19.5 * 3600_000;
