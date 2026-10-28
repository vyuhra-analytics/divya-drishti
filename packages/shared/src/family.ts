// Family accounts: the household's own broker statements, imported and analysed. Pure functions only (the API stores, the screen draws). A record-keeper:
// it holds what the broker reported, never credentials or full account numbers, and gives no advice. See docs/redesign/FAMILY_ACCOUNTS.md.
import { matchFills, reconcileWithStatement, type Reconciliation } from "./fifo";
import type { ChargeHead, PnlLine, Segment } from "./zerodhaPnl";
import type { Fill } from "./zerodhaTradebook";

export type Broker = "zerodha" | "kotak" | "other";
export const BROKER_LABELS: Record<Broker, string> = { zerodha: "Zerodha", kotak: "Kotak", other: "Other" };

export interface FamilyMember {
  id: number;
  nickname: string;
  relation: string;
  hidden: boolean;
  note: string;
}
export interface FamilyAccount {
  id: number;
  memberId: number;
  broker: Broker;
  /** a nickname for the account; never a full account number */
  label: string;
  /** the broker's client id (Zerodha: three letters and three digits). It identifies the account and is not a credential; screens show it masked (maskCode) unless asked. Empty until a file or the owner sets it. */
  clientCode: string;
}
export type ImportKind = "pnl" | "tradebook";
export interface ImportRecord {
  id: number;
  accountId: number;
  /** a P&L statement (realised result per symbol and the charges, no dates) or a tradebook (every fill with its date) */
  kind: ImportKind;
  segment: Segment;
  periodFrom: string;
  periodTo: string;
  fileName: string;
  importedAt: string;
  summary: { charges: number; otherCreditDebit: number; realized: number; unrealized: number };
  /** statement only */
  lines: PnlLine[];
  charges: ChargeHead[];
  /** tradebook only */
  fills: Fill[];
  problems: string[];
}

/** "PZG888" as "***888": enough to tell accounts apart on a screen. */
export const maskCode = (code: string) => (code.length <= 3 ? "*".repeat(code.length) : `${"*".repeat(code.length - 3)}${code.slice(-3)}`);

const FY_START_MONTH = 4; // India's financial year runs April to March

/** The financial year ("2024-25") a date falls in. */
export function fyOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const start = m >= FY_START_MONTH ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** The financial year a period lies wholly in, else the period itself ("2024-04-01 to 2025-06-30"), so a statement that spans two years is never split by a guess. */
export function periodFy(from: string, to: string): string {
  return fyOf(from) === fyOf(to) ? fyOf(from) : `${from} to ${to}`;
}

/** Do two inclusive date ranges share a day? */
export const overlaps = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from <= b.to && b.from <= a.to;

const MONTHS = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC";
const WEEKLY = /^([A-Z][A-Z0-9&-]*?)(\d{2})([1-9OND])(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/;
const MONTHLY = new RegExp(`^([A-Z][A-Z0-9&-]*?)(\\d{2})(${MONTHS})(\\d+(?:\\.\\d+)?)(CE|PE)$`);
const FUTURE = new RegExp(`^([A-Z][A-Z0-9&-]*?)(\\d{2})(${MONTHS})FUT$`);

export interface ParsedSymbol {
  underlying: string;
  kind: "option" | "future" | "other";
  optionType?: "CE" | "PE";
  strike?: number;
}

/** What a broker's F&O symbol is: BANKNIFTY2461951100CE (weekly option), MIDCPNIFTY24JUN12275CE (monthly option), NIFTY24JULFUT (future). Anything else is "other" (a cash symbol). */
export function parseSymbol(symbol: string): ParsedSymbol {
  const s = symbol.trim().toUpperCase();
  let m = WEEKLY.exec(s);
  if (m) return { underlying: m[1], kind: "option", optionType: m[6] as "CE" | "PE", strike: Number(m[5]) };
  m = MONTHLY.exec(s);
  if (m) return { underlying: m[1], kind: "option", optionType: m[5] as "CE" | "PE", strike: Number(m[4]) };
  m = FUTURE.exec(s);
  if (m) return { underlying: m[1], kind: "future" };
  return { underlying: s, kind: "other" };
}

/** A broker's charge head ("Brokerage - Z", "Integrated GST - Z") as the family of charge it belongs to. */
export function chargeGroup(head: string): string {
  const h = head.toLowerCase();
  if (h.includes("brokerage")) return "Brokerage";
  if (h.includes("gst")) return "GST";
  if (h.includes("securities transaction") || h.includes("commodity transaction") || /\bstt\b|\bctt\b/.test(h)) return "STT / CTT";
  if (h.includes("exchange transaction")) return "Exchange";
  if (h.includes("clearing")) return "Clearing";
  if (h.includes("sebi")) return "SEBI";
  if (h.includes("stamp")) return "Stamp duty";
  if (h.includes("ipft")) return "IPFT";
  if (h.includes("dp ") || h.startsWith("dp")) return "DP";
  return "Other";
}

export interface Totals {
  /** realised profit or loss on closed positions, before charges */
  realized: number;
  charges: number;
  /** realised minus charges */
  net: number;
  /** open positions at the end of the period, as the broker marked them: reported, never included in net */
  unrealized: number;
  /** the sum of the profitable symbols and of the losing ones (a loss is negative) */
  profits: number;
  losses: number;
  winners: number;
  losers: number;
  symbols: number;
  /** a lower bound for F&O turnover: the sum of each symbol's absolute net result (true turnover uses every trade, which a statement without trades cannot give) */
  turnoverAtLeast: number;
}
const zero = (): Totals => ({ realized: 0, charges: 0, net: 0, unrealized: 0, profits: 0, losses: 0, winners: 0, losers: 0, symbols: 0, turnoverAtLeast: 0 });
const r2 = (n: number) => Math.round(n * 100) / 100;

function addImport(t: Totals, imp: ImportRecord) {
  for (const l of imp.lines) {
    t.realized += l.realized;
    t.unrealized += l.unrealized;
    t.symbols++;
    t.turnoverAtLeast += Math.abs(l.realized);
    if (l.realized > 0) {
      t.profits += l.realized;
      t.winners++;
    } else if (l.realized < 0) {
      t.losses += l.realized;
      t.losers++;
    }
  }
  t.charges += imp.charges.reduce((a, c) => a + c.amount, 0);
}
function finish(t: Totals): Totals {
  const out = { ...t, realized: r2(t.realized), charges: r2(t.charges), unrealized: r2(t.unrealized), profits: r2(t.profits), losses: r2(t.losses), turnoverAtLeast: r2(t.turnoverAtLeast) };
  out.net = r2(t.realized - t.charges);
  return out;
}

export interface GroupRow extends Totals {
  key: string;
  label: string;
}
export interface Summary {
  totals: Totals;
  /** financial year (or the period of a statement that spans two) */
  byPeriod: GroupRow[];
  byMember: GroupRow[];
  byAccount: GroupRow[];
  bySegment: GroupRow[];
  byUnderlying: GroupRow[];
  /** the family of charge (brokerage, GST, STT...) across the selection */
  chargesByGroup: { group: string; amount: number }[];
  /** every statement used, so the screen can list what the numbers rest on */
  imports: { id: number; accountId: number; segment: Segment; periodFrom: string; periodTo: string; fileName: string; problems: number }[];
}
export interface Filter {
  memberId?: number;
  accountId?: number;
  segment?: Segment;
  /** a financial year label from byPeriod */
  period?: string;
}

/** The whole picture for a selection of statements: totals, and the same numbers cut by period, member, account, segment and underlying. */
export function summarize(members: FamilyMember[], accounts: FamilyAccount[], imports: ImportRecord[], filter: Filter = {}): Summary {
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const mem = new Map(members.map((m) => [m.id, m]));
  const used = imports.filter((i) => {
    if (i.kind !== "pnl") return false; // the totals rest on the broker's own statement; a tradebook only adds the months
    const a = acc.get(i.accountId);
    if (!a) return false;
    if (filter.accountId !== undefined && a.id !== filter.accountId) return false;
    if (filter.memberId !== undefined && a.memberId !== filter.memberId) return false;
    if (filter.segment && i.segment !== filter.segment) return false;
    if (filter.period && periodFy(i.periodFrom, i.periodTo) !== filter.period) return false;
    return true;
  });
  const total = zero();
  const groups = {
    period: new Map<string, { label: string; t: Totals }>(),
    member: new Map<string, { label: string; t: Totals }>(),
    account: new Map<string, { label: string; t: Totals }>(),
    segment: new Map<string, { label: string; t: Totals }>(),
    underlying: new Map<string, { label: string; t: Totals }>(),
  };
  const bump = (m: Map<string, { label: string; t: Totals }>, key: string, label: string, imp: ImportRecord) => {
    const g = m.get(key) ?? { label, t: zero() };
    addImport(g.t, imp);
    m.set(key, g);
  };
  const heads = new Map<string, number>();
  for (const imp of used) {
    const a = acc.get(imp.accountId)!;
    const m = mem.get(a.memberId);
    addImport(total, imp);
    const fy = periodFy(imp.periodFrom, imp.periodTo);
    bump(groups.period, fy, fy, imp);
    bump(groups.member, String(a.memberId), m?.nickname ?? `member ${a.memberId}`, imp);
    bump(groups.account, String(a.id), `${m?.nickname ?? "?"} · ${BROKER_LABELS[a.broker]} · ${a.label}`, imp);
    bump(groups.segment, imp.segment, imp.segment, imp);
    for (const c of imp.charges) heads.set(chargeGroup(c.head), (heads.get(chargeGroup(c.head)) ?? 0) + c.amount);
    // by underlying: the lines carry the realised result, the charges are not split by symbol in a statement
    const by = new Map<string, ImportRecord>();
    for (const l of imp.lines) {
      const u = parseSymbol(l.symbol).underlying;
      const part = by.get(u) ?? { ...imp, lines: [], charges: [] };
      part.lines.push(l);
      by.set(u, part);
    }
    for (const [u, part] of by) bump(groups.underlying, u, u, part);
  }
  const rows = (m: Map<string, { label: string; t: Totals }>, sort: (a: GroupRow, b: GroupRow) => number): GroupRow[] =>
    [...m.entries()].map(([key, g]) => ({ key, label: g.label, ...finish(g.t) })).sort(sort);
  const byKey = (a: GroupRow, b: GroupRow) => a.key.localeCompare(b.key);
  const byNet = (a: GroupRow, b: GroupRow) => a.realized - b.realized;
  return {
    totals: finish(total),
    byPeriod: rows(groups.period, byKey),
    byMember: rows(groups.member, byKey),
    byAccount: rows(groups.account, (a, b) => a.label.localeCompare(b.label)),
    bySegment: rows(groups.segment, byKey),
    byUnderlying: rows(groups.underlying, byNet),
    chargesByGroup: [...heads.entries()].map(([group, amount]) => ({ group, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
    imports: used.map((i) => ({ id: i.id, accountId: i.accountId, segment: i.segment, periodFrom: i.periodFrom, periodTo: i.periodTo, fileName: i.fileName, problems: i.problems.length })),
  };
}

export interface MonthRow {
  month: string;
  /** exact, from the dated fills */
  realized: number;
  /** the statement's charges spread over the months by traded value: an ESTIMATE (a statement gives one total for the whole period) */
  charges: number;
  net: number;
  closes: number;
}
export interface MonthlyView {
  months: MonthRow[];
  /** per statement that has a tradebook covering its period: do the dated fills add up to the statement symbol by symbol? */
  reconciliation: { importId: number; fileName: string; ok: boolean; differences: Reconciliation[] }[];
  /** statements with no tradebook, so their months are missing */
  withoutTradebook: { importId: number; fileName: string; periodFrom: string; periodTo: string }[];
}

/** The month-by-month result for a selection: realised from the tradebooks' dated fills (matched first in, first out), charges from the statements spread by traded value. */
export function monthlyView(members: FamilyMember[], accounts: FamilyAccount[], imports: ImportRecord[], filter: Filter = {}): MonthlyView {
  const acc = new Map(accounts.map((a) => [a.id, a]));
  void members;
  const sel = imports.filter((i) => {
    const a = acc.get(i.accountId);
    if (!a) return false;
    if (filter.accountId !== undefined && a.id !== filter.accountId) return false;
    if (filter.memberId !== undefined && a.memberId !== filter.memberId) return false;
    if (filter.segment && i.segment !== filter.segment) return false;
    return true;
  });
  const months = new Map<string, MonthRow>();
  const row = (m: string) => months.get(m) ?? (months.set(m, { month: m, realized: 0, charges: 0, net: 0, closes: 0 }), months.get(m)!);
  const reconciliation: MonthlyView["reconciliation"] = [];
  const withoutTradebook: MonthlyView["withoutTradebook"] = [];
  const keys = new Set(sel.map((i) => `${i.accountId}|${i.segment}`));
  for (const key of keys) {
    const group = sel.filter((i) => `${i.accountId}|${i.segment}` === key);
    const books = group.filter((i) => i.kind === "tradebook");
    const stmts = group.filter((i) => i.kind === "pnl" && (!filter.period || periodFy(i.periodFrom, i.periodTo) === filter.period));
    const fills = new Map<string, Fill>();
    for (const b of books) for (const f of b.fills) fills.set(f.tradeId, f);
    const matched = matchFills([...fills.values()]);
    const closed = filter.period ? matched.closed.filter((c) => fyOf(c.closeDate) === filter.period) : matched.closed;
    for (const c of closed) {
      const r = row(c.closeDate.slice(0, 7));
      r.realized += c.pnl;
      r.closes++;
    }
    for (const st of stmts) {
      const covering = books.filter((b) => b.periodFrom <= st.periodFrom && b.periodTo >= st.periodTo);
      if (covering.length === 0) {
        withoutTradebook.push({ importId: st.id, fileName: st.fileName, periodFrom: st.periodFrom, periodTo: st.periodTo });
        continue;
      }
      const inPeriod = matched.closed.filter((c) => c.closeDate >= st.periodFrom && c.closeDate <= st.periodTo);
      const diffs = reconcileWithStatement({ closed: inPeriod, open: [] }, st.lines);
      reconciliation.push({ importId: st.id, fileName: st.fileName, ok: diffs.every((d) => d.ok), differences: diffs.filter((d) => !d.ok) });
      const weight = (c: (typeof inPeriod)[number]) => (c.openPrice + c.closePrice) * c.quantity;
      const total = inPeriod.reduce((a, c) => a + weight(c), 0);
      const charges = st.charges.reduce((a, c) => a + c.amount, 0);
      if (total > 0) for (const c of inPeriod) row(c.closeDate.slice(0, 7)).charges += (charges * weight(c)) / total;
    }
  }
  const out = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((m) => ({ ...m, realized: r2(m.realized), charges: r2(m.charges), net: r2(m.realized - m.charges) }));
  return { months: out, reconciliation, withoutTradebook };
}
