// First-in-first-out matching of a broker's fills into closed round trips with dates, which is what gives a month-by-month realised result: a P&L statement has
// totals per symbol and no dates, a tradebook has dates and no results. A position can be long (buys first) or short (sells first); a fill larger than the open
// position closes it and opens the other way. Pure and deterministic: the same fills in any order give the same answer (they are sorted by date, time, trade id).
import type { Fill } from "./zerodhaTradebook";
import type { PnlLine } from "./zerodhaPnl";

export interface ClosedLot {
  symbol: string;
  /** the direction of the position that was closed */
  direction: "long" | "short";
  quantity: number;
  openDate: string;
  closeDate: string;
  openPrice: number;
  closePrice: number;
  /** (close - open) x quantity for a long, (open - close) x quantity for a short; before charges */
  pnl: number;
}
export interface OpenLot {
  symbol: string;
  direction: "long" | "short";
  quantity: number;
  openDate: string;
  openPrice: number;
}
export interface Matched {
  closed: ClosedLot[];
  open: OpenLot[];
}

const byOrder = (a: Fill, b: Fill) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.time ?? "") !== (b.time ?? "") ? ((a.time ?? "") < (b.time ?? "") ? -1 : 1) : a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function matchFills(fills: readonly Fill[]): Matched {
  const closed: ClosedLot[] = [];
  const books = new Map<string, OpenLot[]>();
  for (const f of [...fills].sort(byOrder)) {
    const book = books.get(f.symbol) ?? [];
    books.set(f.symbol, book);
    const direction: "long" | "short" = f.side === "buy" ? "long" : "short";
    let left = f.quantity;
    // lots of the opposite direction are closed first, oldest first
    while (left > 0 && book.length > 0 && book[0].direction !== direction) {
      const lot = book[0];
      const q = Math.min(left, lot.quantity);
      const pnl = lot.direction === "long" ? (f.price - lot.openPrice) * q : (lot.openPrice - f.price) * q;
      closed.push({ symbol: f.symbol, direction: lot.direction, quantity: q, openDate: lot.openDate, closeDate: f.date, openPrice: lot.openPrice, closePrice: f.price, pnl: r6(pnl) });
      lot.quantity -= q;
      left -= q;
      if (lot.quantity === 0) book.shift();
    }
    if (left > 0) book.push({ symbol: f.symbol, direction, quantity: left, openDate: f.date, openPrice: f.price });
  }
  return { closed, open: [...books.values()].flat() };
}

export interface Reconciliation {
  symbol: string;
  /** the statement's realised result for the symbol, and what the tradebook's fills give */
  statement: number | null;
  tradebook: number | null;
  difference: number;
  ok: boolean;
}

/** Symbol by symbol: does the dated tradebook add up to the statement's realised P&L? A position carried in from before the period, or still open, shows as a difference. */
export function reconcileWithStatement(matched: Matched, lines: readonly PnlLine[], tolerance = 0.011): Reconciliation[] {
  const book = new Map<string, number>();
  for (const c of matched.closed) book.set(c.symbol, (book.get(c.symbol) ?? 0) + c.pnl);
  const stmt = new Map<string, number>();
  for (const l of lines) stmt.set(l.symbol, (stmt.get(l.symbol) ?? 0) + l.realized);
  const out: Reconciliation[] = [];
  for (const s of new Set([...book.keys(), ...stmt.keys()])) {
    const a = stmt.get(s) ?? null;
    const b = book.get(s) ?? null;
    const difference = Math.round(((b ?? 0) - (a ?? 0)) * 100) / 100;
    out.push({ symbol: s, statement: a, tradebook: b === null ? null : Math.round(b * 100) / 100, difference, ok: Math.abs(difference) <= tolerance });
  }
  return out.sort((x, y) => x.symbol.localeCompare(y.symbol));
}

/** Realised result by calendar month of the closing date ("2024-06"). */
export function realizedByMonth(closed: readonly ClosedLot[]): { month: string; pnl: number; closes: number }[] {
  const m = new Map<string, { pnl: number; closes: number }>();
  for (const c of closed) {
    const k = c.closeDate.slice(0, 7);
    const g = m.get(k) ?? { pnl: 0, closes: 0 };
    g.pnl += c.pnl;
    g.closes++;
    m.set(k, g);
  }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, g]) => ({ month, pnl: Math.round(g.pnl * 100) / 100, closes: g.closes }));
}
