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

/** The first and last day of a financial year label ("2024-25"). */
export function fyRange(fy: string): { from: string; to: string } {
  const y = Number(fy.slice(0, 4));
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
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

// Kotak writes the contract as words: "BANKNIFTY 24DEC24 CE 52700" (the workbook pads the gaps with spaces)
const KOTAK_OPTION = new RegExp(`^([A-Z][A-Z0-9&-]*?) (\\d{2})(${MONTHS})(\\d{2}) (CE|PE) (\\d+(?:\\.\\d+)?)$`);
const KOTAK_FUTURE = new RegExp(`^([A-Z][A-Z0-9&-]*?) (\\d{2})(${MONTHS})(\\d{2}) FUT$`);

/** What a broker's F&O symbol is: BANKNIFTY2461951100CE (weekly option), MIDCPNIFTY24JUN12275CE (monthly option), NIFTY24JULFUT (future). Anything else is "other" (a cash symbol). */
export function parseSymbol(symbol: string): ParsedSymbol {
  const s = symbol.trim().toUpperCase().replace(/\s+/g, " ");
  const k = KOTAK_OPTION.exec(s);
  if (k) return { underlying: k[1], kind: "option", optionType: k[5] as "CE" | "PE", strike: Number(k[6]) };
  const kf = KOTAK_FUTURE.exec(s);
  if (kf) return { underlying: kf[1], kind: "future" };
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
  /** every statement in the selection gave charges per contract (Kotak's does), so the underlying rows carry charges and net; Zerodha's gives one total for the period */
  underlyingHasCharges: boolean;
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

/**
 * A statement that straddles two financial years (a calendar-year Console export is April-March on both sides of its year end) has no dates, so it cannot be cut by
 * itself (and even one that never crosses a year end is labelled by its file period, not by the year its trades fall in). When a tradebook covering its period reconciles with it symbol by symbol, the dated closes decide which year each result belongs to: one part per year, the
 * realised result per symbol from the closes of that year, the statement's charges shared by traded value (an estimate, exact in total), and any open position's
 * unrealised figure on the last part. Without a covering tradebook that reconciles, the statement is returned whole, labelled with its own period.
 */
export function splitByFinancialYear(imp: ImportRecord, imports: ImportRecord[]): ImportRecord[] {
  if (imp.kind !== "pnl" || fyOf(imp.periodFrom) === fyOf(imp.periodTo)) return [imp];
  const fills = new Map<string, Fill>();
  for (const b of imports) if (b.kind === "tradebook" && b.accountId === imp.accountId && b.segment === imp.segment && b.periodFrom <= imp.periodFrom && b.periodTo >= imp.periodTo) for (const f of b.fills) fills.set(f.tradeId, f);
  if (fills.size === 0) return [imp];
  const inPeriod = matchFills([...fills.values()]).closed.filter((c) => c.closeDate >= imp.periodFrom && c.closeDate <= imp.periodTo);
  if (!reconcileWithStatement({ closed: inPeriod, open: [] }, imp.lines).every((d) => d.ok)) return [imp];
  const weight = (c: (typeof inPeriod)[number]) => (c.openPrice + c.closePrice) * c.quantity;
  const total = inPeriod.reduce((a, c) => a + weight(c), 0);
  const years = [...new Set(inPeriod.map((c) => fyOf(c.closeDate)))].sort();
  if (years.length === 0 || total <= 0) return [imp];
  return years.map((fy, n) => {
    const mine = inPeriod.filter((c) => fyOf(c.closeDate) === fy);
    const share = mine.reduce((a, c) => a + weight(c), 0) / total;
    const lines = new Map<string, PnlLine>();
    for (const c of mine) {
      const l = lines.get(c.symbol) ?? { symbol: c.symbol, quantity: 0, buyValue: 0, sellValue: 0, realized: 0, openQuantity: 0, unrealized: 0 };
      l.quantity += c.quantity;
      l.buyValue += (c.direction === "long" ? c.openPrice : c.closePrice) * c.quantity;
      l.sellValue += (c.direction === "long" ? c.closePrice : c.openPrice) * c.quantity;
      l.realized += c.pnl;
      lines.set(c.symbol, l);
    }
    if (n === years.length - 1)
      for (const o of imp.lines.filter((l) => l.unrealized !== 0 || l.openQuantity !== 0)) {
        const l = lines.get(o.symbol) ?? { symbol: o.symbol, quantity: 0, buyValue: 0, sellValue: 0, realized: 0, openQuantity: 0, unrealized: 0 };
        l.openQuantity += o.openQuantity;
        l.unrealized += o.unrealized;
        lines.set(o.symbol, l);
      }
    const range = fyRange(fy);
    const charges = imp.charges.map((c) => ({ ...c, amount: c.amount * share }));
    const realized = [...lines.values()].reduce((a, l) => a + l.realized, 0);
    return {
      ...imp,
      periodFrom: imp.periodFrom > range.from ? imp.periodFrom : range.from,
      periodTo: imp.periodTo < range.to ? imp.periodTo : range.to,
      lines: [...lines.values()].map((l) => ({ ...l, realized: r2(l.realized) })),
      charges,
      summary: { ...imp.summary, realized: r2(realized), charges: r2(charges.reduce((a, c) => a + c.amount, 0)), unrealized: n === years.length - 1 ? imp.summary.unrealized : 0 },
    };
  });
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
    return true;
  });
  const parts = used.flatMap((i) => splitByFinancialYear(i, imports)).filter((p) => !filter.period || periodFy(p.periodFrom, p.periodTo) === filter.period);
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
  for (const imp of parts) {
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
    for (const [u, part] of by) {
      if (part.lines.every((l) => l.charges !== undefined)) part.charges = [{ head: "Charges", amount: part.lines.reduce((a, l) => a + (l.charges ?? 0), 0) }];
      bump(groups.underlying, u, u, part);
    }
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
    underlyingHasCharges: parts.length > 0 && parts.every((p) => p.lines.every((l) => l.charges !== undefined)),
    chargesByGroup: [...heads.entries()].map(([group, amount]) => ({ group, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
    imports: used.filter((i) => parts.some((p) => p.id === i.id)).map((i) => ({ id: i.id, accountId: i.accountId, segment: i.segment, periodFrom: i.periodFrom, periodTo: i.periodTo, fileName: i.fileName, problems: i.problems.length })),
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
    const stmts = group.filter((i) => i.kind === "pnl" && (!filter.period || overlaps({ from: i.periodFrom, to: i.periodTo }, fyRange(filter.period))));
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
      if (total > 0) for (const c of inPeriod) if (!filter.period || fyOf(c.closeDate) === filter.period) row(c.closeDate.slice(0, 7)).charges += (charges * weight(c)) / total;
    }
  }
  const out = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((m) => ({ ...m, realized: r2(m.realized), charges: r2(m.charges), net: r2(m.realized - m.charges) }));
  return { months: out, reconciliation, withoutTradebook };
}

const csvCell = (v: string | number): string => {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  // a text cell that starts like a formula would be run by a spreadsheet: keep it text
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Rows of values as CSV text (CRLF lines, quotes doubled, formula-looking text defused). */
export const toCsv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

/**
 * A statement-style export of what the screen shows: the totals, then the same numbers by financial year, member, account, segment and underlying, the charges
 * by group and the months. `nameOf` turns a member or account key into text (so the export carries the names the owner typed, never the client id).
 */
export function familyCsv(report: { summary: Summary; monthly: MonthlyView }, nameOf: { member: (id: number) => string; account: (id: number) => string }): string {
  const s = report.summary;
  const head = ["Realised", "Charges", "Net", "Unrealised (reported)", "Winning symbols", "Losing symbols"];
  const cells = (t: Totals) => [t.realized, t.charges, t.net, t.unrealized, t.winners, t.losers];
  const rows: (string | number)[][] = [["Family broker statements: realised P&L, charges and taxes"], [], ["Total", ...head], ["All selected", ...cells(s.totals)], []];
  const block = (title: string, list: GroupRow[], label: (r: GroupRow) => string) => {
    if (!list.length) return;
    rows.push([title, ...head]);
    for (const r of list) rows.push([label(r), ...cells(r)]);
    rows.push([]);
  };
  block("Financial year", s.byPeriod, (r) => r.label);
  block("Member", s.byMember, (r) => nameOf.member(Number(r.key)));
  block("Account", s.byAccount, (r) => nameOf.account(Number(r.key)));
  block("Segment", s.bySegment, (r) => r.key);
  block(s.underlyingHasCharges ? "Underlying" : "Underlying (realised only: charges are not split by symbol)", s.underlyingHasCharges ? s.byUnderlying : s.byUnderlying.map((r) => ({ ...r, charges: 0, net: r.realized })), (r) => r.label);
  if (s.chargesByGroup.length) {
    rows.push(["Charges and taxes", "Amount"]);
    for (const c of s.chargesByGroup) rows.push([c.group, c.amount]);
    rows.push([]);
  }
  if (report.monthly.months.length) {
    rows.push(["Month", "Realised (exact, from dated trades)", "Charges (estimated: the statement total spread by traded value)", "Net", "Closes"]);
    for (const m of report.monthly.months) rows.push([m.month, m.realized, m.charges, m.net, m.closes]);
  }
  return toCsv(rows);
}
