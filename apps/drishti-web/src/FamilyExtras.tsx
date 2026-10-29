import type { ReactNode } from "react";
import { runningSeries, SERIES_PICK, type DayResult, type DayRisk, type DayRow, type FyHeadline, type GroupRow, type HabitRow, type Habits, type LastDay, type RunningPoint, type Totals } from "@drishti/shared";

// Pieces of the Family overview that are only drawing: the recent-days bars, the year so far, the risk figures and the habit tables. All numbers arrive computed
// (shared familyHabits.ts and family.ts); `money` and `signed` are the panel's own, so hidden amounts stay hidden here too.

export interface Fmt {
  hide: boolean;
  money: (n: number) => string;
  signed: (n: number) => ReactNode;
}

const SHORT: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
const FULL: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const when = (iso: string, opts: Intl.DateTimeFormatOptions = SHORT) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { ...opts, timeZone: "UTC" });

/** The last trading days as bars: gain above the line, loss below. With amounts hidden the bars stay (the shape is the point) but carry no tooltip. */
export function RecentDays({ days, hide }: { days: DayResult[]; hide: boolean }) {
  if (days.length < 2) return null;
  const max = Math.max(1, ...days.map((d) => Math.abs(d.net)));
  const W = 220;
  const H = 44;
  const bw = W / days.length;
  const mid = H / 2;
  return (
    <svg className="fam-recent" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={hide ? `Last ${days.length} trading days (values hidden)` : `Last ${days.length} trading days`}>
      <line x1="0" x2={W} y1={mid} y2={mid} className="fam-axis" />
      {days.map((d, i) => {
        const h = Math.max(1, (Math.abs(d.net) / max) * (mid - 2));
        return (
          <rect key={d.date} x={i * bw + 2} width={bw - 4} y={d.net >= 0 ? mid - h : mid} height={h} className={d.net > 0 ? "fam-bar-up" : d.net < 0 ? "fam-bar-down" : "fam-bar-flat"}>
            {!hide && <title>{`${when(d.date)}: ${d.net.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`}</title>}
          </rect>
        );
      })}
    </svg>
  );
}

/** Each person's own latest trading day, when it is more than one person. */
export function ByMember({ rows, name, fmt }: { rows: LastDay["byMember"]; name: (id: number) => string; fmt: Fmt }) {
  if (rows.length < 2) return null;
  return (
    <ul className="fam-lastday-split" aria-label="Each person's latest trading day">
      {rows.map((r) => (
        <li key={r.memberId}>
          {name(r.memberId)} ({when(r.date)}): {fmt.signed(r.net)}
        </li>
      ))}
    </ul>
  );
}

export interface KpiSpec {
  key: string;
  label: string;
  value: number;
  /** a profit or loss (signed, coloured) or a cost (shown plain; more of it is bad) */
  kind: "pnl" | "cost";
  /** what the last trading day added to it; absent when no dated trades are loaded */
  change?: number;
  /** the running total over the last days, ending at the figure */
  series?: RunningPoint[];
  sub: string;
  net?: boolean;
}

/** An arrow for the direction the figure moved and a colour for whether that is good: up is good for a result, bad for a cost. */
export function Change({ amount, kind, day, fmt }: { amount: number; kind: "pnl" | "cost"; day: string; fmt: Fmt }) {
  const dir = amount > 0 ? "up" : amount < 0 ? "down" : "flat";
  const tone = dir === "flat" ? "flat" : (dir === "up") === (kind === "pnl") ? "up" : "down";
  const word = dir === "up" ? "Up" : dir === "down" ? "Down" : "Unchanged";
  return (
    <span className={`fam-delta ${tone}`} title={`Change on the last trading day, ${when(day, FULL)}`} aria-label={`${word}${fmt.hide || dir === "flat" ? "" : ` ${fmt.money(Math.abs(amount))}`} on ${when(day, FULL)}, ${tone === "up" ? "good" : tone === "down" ? "bad" : "no change"}`}>
      <i aria-hidden="true">{dir === "up" ? "▲" : dir === "down" ? "▼" : "■"}</i> {fmt.hide ? "••••" : fmt.money(Math.abs(amount))} <small>{when(day)}</small>
    </span>
  );
}

/** The running total as a line, the last day's step in the colour of what it did to the figure. The shape stays with amounts hidden. */
export function Spark({ points, kind, hide }: { points: RunningPoint[]; kind: "pnl" | "cost"; hide: boolean }) {
  if (points.length < 3) return null;
  const W = 120;
  const H = 26;
  const lo = Math.min(...points.map((p) => p.total));
  const hi = Math.max(...points.map((p) => p.total));
  const span = hi - lo || 1;
  const x = (i: number) => (i / (points.length - 1)) * (W - 4) + 2;
  const y = (v: number) => H - 3 - ((v - lo) / span) * (H - 6);
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const step = last.total - prev.total;
  const tone = step === 0 ? "flat" : (step > 0) === (kind === "pnl") ? "up" : "down";
  return (
    <svg className="fam-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={hide ? `Running total, last ${points.length} days (values hidden)` : `Running total over the last ${points.length} days with a result`}>
      <polyline className="fam-spark-line" points={points.map((p, i) => `${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(" ")} />
      <line className={`fam-spark-last ${tone}`} x1={x(points.length - 2)} y1={y(prev.total)} x2={x(points.length - 1)} y2={y(last.total)} />
      <circle className={`fam-spark-dot ${tone}`} cx={x(points.length - 1)} cy={y(last.total)} r="2.5">
        {!hide && <title>{`${when(last.date)}: ${last.total.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`}</title>}
      </circle>
    </svg>
  );
}

/** Three cards: realised, charges, net. Each carries what the last trading day did to it and the running total behind it. */
export function KpiTrio({ cards, day, fmt }: { cards: KpiSpec[]; day?: string; fmt: Fmt }) {
  return (
    <div className="fam-kpis">
      {cards.map((c) => (
        <div key={c.key} className={`fam-kpi${c.net ? ` net ${c.value > 0 ? "up" : c.value < 0 ? "down" : ""}` : ""}`}>
          <span>{c.label}</span>
          <b>{c.kind === "pnl" ? fmt.signed(c.value) : fmt.hide ? "••••" : fmt.money(c.value)}</b>
          {day !== undefined && c.change !== undefined && <Change amount={c.change} kind={c.kind} day={day} fmt={fmt} />}
          {c.series && <Spark points={c.series} kind={c.kind} hide={fmt.hide} />}
          <small>{fmt.hide ? "••" : c.sub}</small>
        </div>
      ))}
    </div>
  );
}

const n2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function cardsFor(t: Totals, last: LastDay | null | undefined, days: DayRow[], from: string | undefined, subs: { realized: string; charges: string; net: string }): KpiSpec[] {
  return [
    { key: "realized", label: "Realised P&L", value: t.realized, kind: "pnl", change: last?.realized, series: runningSeries(days, SERIES_PICK.realized, from), sub: subs.realized },
    { key: "charges", label: "Charges and taxes", value: t.charges, kind: "cost", change: last?.charges, series: runningSeries(days, SERIES_PICK.charges, from), sub: subs.charges },
    { key: "net", label: "Net after charges", value: t.net, kind: "pnl", change: last?.net, series: runningSeries(days, SERIES_PICK.net, from), sub: subs.net, net: true },
  ];
}
const winningsShare = (t: Totals) => (t.profits > 0 ? `${((t.charges / t.profits) * 100).toFixed(1)}% of the winnings` : "no winnings to compare");

/** The three cards of the financial year so far. */
export function fyCards(h: FyHeadline, last: LastDay | null | undefined, days: DayRow[]): KpiSpec[] {
  const t = h.totals;
  const won = t.winners + t.losers > 0 ? `${Math.round((t.winners / (t.winners + t.losers)) * 100)}% of symbols won` : "no symbols closed";
  const prev = h.previous ? `${h.previous.fy} in full: ${n2(h.previous.totals.net)}` : "";
  const net = h.daysNetLastYear === null ? prev || "no earlier year to compare" : `same stretch of last year: ${n2(h.daysNetLastYear)}${prev ? ` · ${prev}` : ""}`;
  return cardsFor(t, last, days, `${h.fy.slice(0, 4)}-04-01`, { realized: won, charges: winningsShare(t), net });
}

/** The three cards for everything selected (all years, or the one year chosen). */
export function allCards(t: Totals, byPeriod: GroupRow[], last: LastDay | null | undefined, days: DayRow[]): KpiSpec[] {
  const best = [...byPeriod].sort((x, y) => y.net - x.net);
  const net = byPeriod.length > 1 ? `best ${best[0].label} ${Math.round(best[0].net).toLocaleString("en-IN")}, worst ${best[best.length - 1].label} ${Math.round(best[best.length - 1].net).toLocaleString("en-IN")}` : "after brokerage, taxes and fees";
  return cardsFor(t, last, days, undefined, { realized: `${t.winners} winning, ${t.losers} losing symbols`, charges: winningsShare(t), net });
}

/** The financial year so far, with last year's same stretch. */
export function YearSoFar({ h, cards, day, fmt }: { h: FyHeadline; cards: KpiSpec[]; day?: string; fmt: Fmt }) {
  return (
    <section className="fam-year" data-testid="fam-year">
      <h2>
        FY {h.fy} so far <small className="muted">to {when(h.through, FULL)}</small>
      </h2>
      <KpiTrio cards={cards} day={day} fmt={fmt} />
    </section>
  );
}

/** Best and worst day, the current run, and the deepest fall of the running net. */
export function RiskCard({ r, fmt }: { r: DayRisk; fmt: Fmt }) {
  const cell = (label: string, value: ReactNode, small: string) => (
    <div>
      <span>{label}</span>
      <b>{value}</b>
      <small>{fmt.hide ? "••" : small}</small>
    </div>
  );
  return (
    <section className="fam-card" data-testid="fam-risk">
      <h2>Best days, worst days and the fall from the peak</h2>
      <div className="fam-stats">
        {cell("Best day", fmt.signed(r.bestDay.net), when(r.bestDay.date, FULL))}
        {cell("Worst day", fmt.signed(r.worstDay.net), when(r.worstDay.date, FULL))}
        {cell("Right now", r.streak.kind === "flat" ? "flat" : `${r.streak.days} ${r.streak.kind === "win" ? "winning" : "losing"} day${r.streak.days === 1 ? "" : "s"}`, `${r.winDays} winning and ${r.lossDays} losing days of ${r.days}`)}
        {cell("Deepest fall", fmt.signed(-r.maxDrawdown.amount), `${r.maxDrawdown.from ? `from ${when(r.maxDrawdown.from, FULL)}` : "from the start"} to ${when(r.maxDrawdown.to, FULL)}`)}
        {cell("Below the peak now", r.currentDrawdown === 0 ? "at a new high" : fmt.signed(-r.currentDrawdown), "running net after charges, dated trades only")}
      </div>
    </section>
  );
}

function HabitTable({ title, note, unit, rows, fmt, avgLabel }: { title: string; note: string; unit: string; rows: HabitRow[]; fmt: Fmt; avgLabel: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="fam-scroll">
      <h3>{title}</h3>
      <table className="fam-table">
        <thead>
          <tr>
            <th />
            <th className="num">{unit}</th>
            <th className="num">{avgLabel}</th>
            <th className="num">Total</th>
            <th className="num">Won</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.thin ? "fam-thin" : undefined} title={r.thin ? "Fewer than five: too few to read a pattern into" : undefined}>
              <td>
                {r.label}
                {r.thin ? " *" : ""}
              </td>
              <td className="num">{r.n}</td>
              <td className="num">{fmt.signed(r.avg)}</td>
              <td className="num">{fmt.signed(r.total)}</td>
              <td className="num">{fmt.hide ? "••" : `${Math.round(r.winRate * 100)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <small className="muted">{note}</small>
    </div>
  );
}

/** Result by weekday, holding time, kind and how busy the day was. */
export function HabitsCard({ h, fmt }: { h: Habits; fmt: Fmt }) {
  return (
    <section className="fam-card" data-testid="fam-habits">
      <h2>Habits: when and how the results came</h2>
      <p className="muted">
        From the {h.positions} positions closed in the dated tradebooks, over {h.days} trading days. Results are before charges, except the busy-day table. A description of what happened, not a signal; * marks rows with
        fewer than five.
      </p>
      <div className="fam-habits">
        <HabitTable title="By weekday closed" note="Weekday of the close." unit="Positions" avgLabel="Average" rows={h.weekday} fmt={fmt} />
        <HabitTable title="By time held" note="Same day means opened and closed on one date." unit="Positions" avgLabel="Average" rows={h.hold} fmt={fmt} />
        <HabitTable title="By what was traded" note="Bought or sold, calls, puts or futures." unit="Positions" avgLabel="Average" rows={h.kind} fmt={fmt} />
        <HabitTable title="By how busy the day was" note="Positions closed that day; the result is the day's net after charges." unit="Days" avgLabel="Avg day" rows={h.busy} fmt={fmt} />
      </div>
    </section>
  );
}
