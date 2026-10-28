// What the Family screen reads out of the stored statements beyond the totals: every contract as a row, why the result is what it is (win rate, size of wins
// against losses), the year-by-segment and member-by-year tables, which statements are loaded for which year, and the statement an accountant is sent. All pure
// functions over the same statements `summarize` uses, so the numbers on every view agree. A record-keeper: nothing here judges a trade or suggests one.
import { BROKER_LABELS, chargeGroup, fyOf, fyRange, maskCode, overlaps, parseSymbol, selectParts, type FamilyAccount, type FamilyMember, type Filter, type ImportRecord, type StatementPart } from "./family";
import { SEGMENT_LABELS, type Segment } from "./zerodhaPnl";

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- every contract as a row

export interface ContractRow {
  /** unique within a selection */
  id: string;
  symbol: string;
  underlying: string;
  kind: "option" | "future" | "other";
  segment: Segment;
  memberId: number;
  accountId: number;
  fy: string;
  quantity: number;
  /** the realised result as the statement reports it, before charges */
  realized: number;
  /** the charges on this contract, when the statement gives them per contract (Kotak's does, Zerodha's does not) */
  charges?: number;
  /** realised less charges; only when the charges are known */
  net?: number;
  file: string;
}

/** Every contract of the statements in a selection. A statement carries one line per contract for the whole period. */
export function contractRows(parts: StatementPart[]): ContractRow[] {
  const rows: ContractRow[] = [];
  for (const { imp, memberId, accountId, fy } of parts)
    imp.lines.forEach((l, i) => {
      const p = parseSymbol(l.symbol);
      rows.push({
        id: `${imp.id}-${fy}-${i}`,
        symbol: l.symbol,
        underlying: p.underlying,
        kind: p.kind,
        segment: imp.segment,
        memberId,
        accountId,
        fy,
        quantity: l.quantity,
        realized: r2(l.realized),
        ...(l.charges !== undefined ? { charges: r2(l.charges), net: r2(l.realized - l.charges) } : {}),
        file: imp.fileName,
      });
    });
  return rows;
}

// ---- why the result is what it is

export interface SegmentInsight {
  segment: Segment;
  contracts: number;
  winRate: number;
  payoff: number | null;
  profitFactor: number | null;
  realized: number;
}
export interface Insights {
  contracts: number;
  winners: number;
  losers: number;
  /** winners / (winners + losers): contracts that closed flat are left out */
  winRate: number;
  avgWin: number;
  /** a negative number */
  avgLoss: number;
  /** average win divided by the size of the average loss: under 1 means the typical loss is bigger than the typical win; null with no losses */
  payoff: number | null;
  /** the sum of the winnings divided by the sum of the losses: under 1 means more was lost than won; null with no losses */
  profitFactor: number | null;
  /** realised result per contract, before charges */
  expectancy: number;
  grossProfit: number;
  grossLoss: number;
  charges: number;
  /** charges as a share of the winnings, and as a share of the losses (null when there are none) */
  chargesOfWinnings: number | null;
  chargesOfLosses: number | null;
  worst: ContractRow[];
  best: ContractRow[];
  /** how much of all the losses the five worst contracts account for, 0 to 1 */
  worstFiveShare: number | null;
  bySegment: SegmentInsight[];
  /** one plain sentence on what the numbers say; facts only */
  verdict: string;
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

/** The shape of the results in a selection: how often, how big, and where the losses sit. Undefined when no contract closed with a result. */
export function insights(rows: ContractRow[], parts: StatementPart[]): Insights | undefined {
  const decided = rows.filter((r) => r.realized !== 0);
  if (decided.length === 0) return undefined;
  const wins = decided.filter((r) => r.realized > 0);
  const losses = decided.filter((r) => r.realized < 0);
  const grossProfit = wins.reduce((a, r) => a + r.realized, 0);
  const grossLoss = losses.reduce((a, r) => a + r.realized, 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const charges = parts.reduce((a, p) => a + p.imp.charges.reduce((x, c) => x + c.amount, 0), 0);
  const worst = [...losses].sort((a, b) => a.realized - b.realized).slice(0, 5);
  const best = [...wins].sort((a, b) => b.realized - a.realized).slice(0, 5);
  const segs = [...new Set(rows.map((r) => r.segment))].sort();
  const bySegment: SegmentInsight[] = segs.map((segment) => {
    const mine = decided.filter((r) => r.segment === segment);
    const w = mine.filter((r) => r.realized > 0);
    const l = mine.filter((r) => r.realized < 0);
    const wsum = w.reduce((a, r) => a + r.realized, 0);
    const lsum = l.reduce((a, r) => a + r.realized, 0);
    return { segment, contracts: mine.length, winRate: mine.length ? w.length / mine.length : 0, payoff: l.length && w.length ? ratio(wsum / w.length, Math.abs(lsum / l.length)) : null, profitFactor: ratio(wsum, Math.abs(lsum)), realized: r2(wsum + lsum) };
  });
  const winRate = wins.length / decided.length;
  const payoff = wins.length && losses.length ? ratio(avgWin, Math.abs(avgLoss)) : null;
  const profitFactor = ratio(grossProfit, Math.abs(grossLoss));
  const net = grossProfit + grossLoss;
  let verdict: string;
  if (payoff !== null && winRate >= 0.5 && net < 0) verdict = `${Math.round(winRate * 100)}% of contracts closed in profit, but the average loss is ${(1 / payoff).toFixed(1)} times the average win, so the result is negative.`;
  else if (payoff !== null && winRate < 0.5 && net < 0) verdict = `${Math.round(winRate * 100)}% of contracts closed in profit and the average win is ${payoff.toFixed(2)} times the average loss, so the wins do not cover the losses.`;
  else if (net >= 0) verdict = `${Math.round(winRate * 100)}% of contracts closed in profit and the wins outweigh the losses before charges.`;
  else verdict = `Every contract with a result closed at a loss.`;
  const worstFiveShare = grossLoss < 0 ? worst.reduce((a, r) => a + r.realized, 0) / grossLoss : null;
  return {
    contracts: decided.length,
    winners: wins.length,
    losers: losses.length,
    winRate,
    avgWin: r2(avgWin),
    avgLoss: r2(avgLoss),
    payoff: payoff === null ? null : Math.round(payoff * 100) / 100,
    profitFactor: profitFactor === null ? null : Math.round(profitFactor * 100) / 100,
    expectancy: r2(net / decided.length),
    grossProfit: r2(grossProfit),
    grossLoss: r2(grossLoss),
    charges: r2(charges),
    chargesOfWinnings: grossProfit > 0 ? charges / grossProfit : null,
    chargesOfLosses: grossLoss < 0 ? charges / Math.abs(grossLoss) : null,
    worst,
    best,
    worstFiveShare,
    bySegment,
    verdict,
  };
}

// ---- year by segment, member by year

export interface CrossTab {
  rows: { key: string; label: string }[];
  cols: { key: string; label: string }[];
  /** cells[row][col]: realised, charges and net of the statements in that cell */
  cells: Record<string, Record<string, { realized: number; charges: number; net: number }>>;
}

/** The net of the selection laid out as a table: each statement part goes in one cell, by the two keys given. */
export function crossTab(parts: StatementPart[], rowOf: (p: StatementPart) => { key: string; label: string }, colOf: (p: StatementPart) => { key: string; label: string }): CrossTab {
  const rows = new Map<string, string>();
  const cols = new Map<string, string>();
  const cells: CrossTab["cells"] = {};
  for (const p of parts) {
    const r = rowOf(p);
    const c = colOf(p);
    rows.set(r.key, r.label);
    cols.set(c.key, c.label);
    const cell = ((cells[r.key] ??= {})[c.key] ??= { realized: 0, charges: 0, net: 0 });
    cell.realized += p.imp.lines.reduce((a, l) => a + l.realized, 0);
    cell.charges += p.imp.charges.reduce((a, ch) => a + ch.amount, 0);
  }
  for (const r of Object.values(cells)) for (const c of Object.values(r)) (c.realized = r2(c.realized)), (c.charges = r2(c.charges)), (c.net = r2(c.realized - c.charges));
  const list = (m: Map<string, string>) => [...m.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.key.localeCompare(b.key));
  return { rows: list(rows), cols: list(cols), cells };
}

export const yearBySegment = (parts: StatementPart[]) => crossTab(parts, (p) => ({ key: p.fy, label: p.fy }), (p) => ({ key: p.imp.segment, label: SEGMENT_LABELS[p.imp.segment] ?? p.imp.segment }));
export const memberByYear = (parts: StatementPart[], members: FamilyMember[]) => {
  const name = (id: number) => members.find((m) => m.id === id)?.nickname ?? `member ${id}`;
  return crossTab(parts, (p) => ({ key: String(p.memberId), label: name(p.memberId) }), (p) => ({ key: p.fy, label: p.fy }));
};

// ---- which statements are loaded for which year

export interface CoverageCell {
  /** segments with a statement covering (part of) the year */
  statements: Segment[];
  tradebook: boolean;
  /** every file contributing covers only part of the financial year */
  partial: boolean;
}
export interface CoverageView {
  years: string[];
  rows: { accountId: number; memberId: number; cells: Record<string, CoverageCell> }[];
}

/** For every account and financial year: which statements and tradebooks are loaded. Independent of the screen's filters, since it is about the files. */
export function statementCoverage(accounts: FamilyAccount[], imports: ImportRecord[]): CoverageView {
  const years = new Set<string>();
  const rows = accounts.map((a) => ({ accountId: a.id, memberId: a.memberId, cells: {} as Record<string, CoverageCell>, full: {} as Record<string, boolean> }));
  for (const imp of imports) {
    const row = rows.find((r) => r.accountId === imp.accountId);
    if (!row) continue;
    for (let y = Number(fyOf(imp.periodFrom).slice(0, 4)); y <= Number(fyOf(imp.periodTo).slice(0, 4)); y++) {
      const fy = `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
      years.add(fy);
      const range = fyRange(fy);
      if (!overlaps({ from: imp.periodFrom, to: imp.periodTo }, range)) continue;
      const cell = (row.cells[fy] ??= { statements: [], tradebook: false, partial: true });
      if (imp.kind === "pnl") {
        if (!cell.statements.includes(imp.segment)) cell.statements.push(imp.segment);
      } else cell.tradebook = true;
      if (imp.periodFrom <= range.from && imp.periodTo >= range.to) row.full[fy] = true;
    }
  }
  for (const row of rows) for (const fy of Object.keys(row.cells)) row.cells[fy].partial = !row.full[fy];
  return { years: [...years].sort(), rows: rows.map(({ accountId, memberId, cells }) => ({ accountId, memberId, cells })) };
}

// ---- the statement an accountant is sent

export interface StatementSegment {
  segment: Segment;
  contracts: number;
  winners: number;
  losers: number;
  realized: number;
  charges: { group: string; amount: number }[];
  chargesTotal: number;
  net: number;
  /** a lower bound: the sum of each contract's absolute result (the filing figure needs every trade) */
  turnoverAtLeast: number;
}
export interface AccountantStatement {
  memberId: number;
  fy: string;
  accounts: { id: number; broker: string; label: string; client: string }[];
  segments: StatementSegment[];
  totals: { contracts: number; realized: number; chargesTotal: number; net: number; turnoverAtLeast: number };
  contracts: ContractRow[];
  /** true when `fy` is a statement's own period because no reconciling tradebook let it be cut into financial years */
  notCut: boolean;
}

/** One member's year as a statement: per segment the realised result, the charges by head and the net, then every contract. */
export function accountantStatement(members: FamilyMember[], accounts: FamilyAccount[], imports: ImportRecord[], memberId: number, fy: string): AccountantStatement | undefined {
  const filter: Filter = { memberId, period: fy };
  const parts = selectParts(accounts, imports, filter);
  if (parts.length === 0) return undefined;
  void members;
  const segs = [...new Set(parts.map((p) => p.imp.segment))].sort();
  const segments: StatementSegment[] = segs.map((segment) => {
    const mine = parts.filter((p) => p.imp.segment === segment);
    const lines = mine.flatMap((p) => p.imp.lines);
    const heads = new Map<string, number>();
    for (const p of mine) for (const c of p.imp.charges) heads.set(chargeGroup(c.head), (heads.get(chargeGroup(c.head)) ?? 0) + c.amount);
    const realized = lines.reduce((a, l) => a + l.realized, 0);
    const chargesTotal = [...heads.values()].reduce((a, b) => a + b, 0);
    return {
      segment,
      contracts: lines.length,
      winners: lines.filter((l) => l.realized > 0).length,
      losers: lines.filter((l) => l.realized < 0).length,
      realized: r2(realized),
      charges: [...heads.entries()].map(([group, amount]) => ({ group, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
      chargesTotal: r2(chargesTotal),
      net: r2(realized - chargesTotal),
      turnoverAtLeast: r2(lines.reduce((a, l) => a + Math.abs(l.realized), 0)),
    };
  });
  const sum = (f: (s: StatementSegment) => number) => r2(segments.reduce((a, s) => a + f(s), 0));
  const mine = accounts.filter((a) => a.memberId === memberId && parts.some((p) => p.accountId === a.id));
  return {
    memberId,
    fy,
    accounts: mine.map((a) => ({ id: a.id, broker: BROKER_LABELS[a.broker], label: a.label, client: a.clientCode ? maskCode(a.clientCode) : "" })),
    segments,
    totals: { contracts: sum((s) => s.contracts), realized: sum((s) => s.realized), chargesTotal: sum((s) => s.chargesTotal), net: sum((s) => s.net), turnoverAtLeast: sum((s) => s.turnoverAtLeast) },
    contracts: contractRows(parts),
    notCut: !/^\d{4}-\d{2}$/.test(fy),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inr = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NOTE = "Prepared from the broker statements you uploaded, as reported. Realised results are before charges; the turnover shown is a lower bound (the sum of each contract's absolute result), not the filing figure. This is a record, not tax advice: ask your accountant how each segment is treated.";

/** The statement as a printable HTML page (all text escaped). `memberName` is what the owner typed; the client id appears masked. */
export function statementHtml(st: AccountantStatement, memberName: string): string {
  const row = (cells: string[], head = false) => `<tr>${cells.map((c, i) => `<${head ? "th" : "td"}${i > 0 ? ' class="n"' : ""}>${c}</${head ? "th" : "td"}>`).join("")}</tr>`;
  const segs = st.segments
    .map(
      (s) => `<h3>${esc(SEGMENT_LABELS[s.segment])}</h3><table>${row(["", "Amount (Rs)"], true)}${row(["Contracts (winning / losing)", `${s.contracts} (${s.winners} / ${s.losers})`])}${row(["Realised profit or loss, before charges", inr(s.realized)])}${s.charges.map((c) => row([`Charges: ${esc(c.group)}`, inr(c.amount)])).join("")}${row(["<b>Total charges</b>", `<b>${inr(s.chargesTotal)}</b>`])}${row(["<b>Net after charges</b>", `<b>${inr(s.net)}</b>`])}${row(["Turnover, at least", inr(s.turnoverAtLeast)])}</table>`,
    )
    .join("");
  const contracts = st.contracts
    .sort((a, b) => a.segment.localeCompare(b.segment) || a.symbol.localeCompare(b.symbol))
    .map((c) => row([esc(SEGMENT_LABELS[c.segment]), esc(c.symbol), String(c.quantity), inr(c.realized), c.charges === undefined ? "" : inr(c.charges)]))
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Statement ${esc(st.fy)} ${esc(memberName)}</title><style>body{font:13px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0}h2{font-size:15px;margin:20px 0 4px}h3{font-size:13px;margin:16px 0 4px}table{border-collapse:collapse;width:100%;max-width:720px}th,td{padding:3px 8px;border-bottom:1px solid #ddd;text-align:left}.n{text-align:right;font-variant-numeric:tabular-nums}small{color:#555}@media print{body{margin:8px}}</style></head><body><h1>Trading statement, ${st.notCut ? `period ${esc(st.fy)}` : `financial year ${esc(st.fy)}`}</h1><p>${esc(memberName)}<br>${st.accounts.map((a) => `<small>${esc(a.broker)} account ${esc(a.client)}</small>`).join("<br>")}</p><h2>Summary</h2><table>${row(["", "Amount (Rs)"], true)}${row(["Contracts", String(st.totals.contracts)])}${row(["Realised profit or loss, before charges", inr(st.totals.realized)])}${row(["Charges and taxes", inr(st.totals.chargesTotal)])}${row(["<b>Net after charges</b>", `<b>${inr(st.totals.net)}</b>`])}${row(["Turnover, at least", inr(st.totals.turnoverAtLeast)])}</table><h2>By segment</h2>${segs}${st.notCut ? `<p><small>This period was not cut into financial years because no tradebook that matches the statement was loaded, so it may span two of them.</small></p>` : ""}<h2>Contracts</h2><table>${row(["Segment", "Contract", "Qty", "Realised (Rs)", "Charges (Rs)"], true)}${contracts}</table><p><small>${esc(NOTE)}</small></p></body></html>`;
}

/** The statement as CSV rows (turned into text by `toCsv`). */
export function statementRows(st: AccountantStatement, memberName: string): (string | number)[][] {
  const rows: (string | number)[][] = [[st.notCut ? `Trading statement, period ${st.fy} (not cut into financial years)` : `Trading statement, financial year ${st.fy}`], [memberName], ...st.accounts.map((a) => [`${a.broker} account ${a.client}`]), [], ["Segment", "Contracts", "Winning", "Losing", "Realised (before charges)", "Charges", "Net", "Turnover (at least)"]];
  for (const s of st.segments) rows.push([SEGMENT_LABELS[s.segment], s.contracts, s.winners, s.losers, s.realized, s.chargesTotal, s.net, s.turnoverAtLeast]);
  rows.push(["Total", st.totals.contracts, "", "", st.totals.realized, st.totals.chargesTotal, st.totals.net, st.totals.turnoverAtLeast], []);
  rows.push(["Charges by head"]);
  for (const s of st.segments) for (const c of s.charges) rows.push([SEGMENT_LABELS[s.segment], c.group, c.amount]);
  rows.push([], ["Segment", "Contract", "Quantity", "Realised (before charges)", "Charges (where given per contract)"]);
  for (const c of [...st.contracts].sort((a, b) => a.segment.localeCompare(b.segment) || a.symbol.localeCompare(b.symbol))) rows.push([SEGMENT_LABELS[c.segment], c.symbol, c.quantity, c.realized, c.charges ?? ""]);
  rows.push([], [NOTE]);
  return rows;
}
