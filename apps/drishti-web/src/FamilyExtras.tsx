import type { ReactNode } from "react";
import type { DayResult, DayRisk, FyHeadline, HabitRow, Habits, LastDay } from "@drishti/shared";

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

/** The financial year so far, with last year's same stretch. */
export function YearSoFar({ h, fmt }: { h: FyHeadline; fmt: Fmt }) {
  const t = h.totals;
  const win = t.winners + t.losers > 0 ? Math.round((t.winners / (t.winners + t.losers)) * 100) : null;
  return (
    <section className="fam-year" data-testid="fam-year">
      <h2>
        FY {h.fy} so far <small className="muted">to {when(h.through, FULL)}</small>
      </h2>
      <div className="fam-kpis">
        <div className="fam-kpi">
          <span>Realised P&amp;L</span>
          <b>{fmt.signed(t.realized)}</b>
          <small>{fmt.hide || win === null ? "••" : `${win}% of symbols won`}</small>
        </div>
        <div className="fam-kpi">
          <span>Charges and taxes</span>
          <b>{fmt.hide ? "••••" : fmt.money(t.charges)}</b>
          <small>{fmt.hide ? "••" : t.profits > 0 ? `${((t.charges / t.profits) * 100).toFixed(1)}% of the winnings` : "no winnings to compare"}</small>
        </div>
        <div className={`fam-kpi net ${t.net > 0 ? "up" : t.net < 0 ? "down" : ""}`}>
          <span>Net after charges</span>
          <b>{fmt.signed(t.net)}</b>
          <small>
            {fmt.hide
              ? "••"
              : h.daysNetLastYear === null
                ? h.previous
                  ? `${h.previous.fy} in full: ${fmt.money(h.previous.totals.net)}`
                  : "no earlier year to compare"
                : `same stretch of last year: ${fmt.money(h.daysNetLastYear)}${h.previous ? ` · ${h.previous.fy} in full: ${fmt.money(h.previous.totals.net)}` : ""}`}
          </small>
        </div>
      </div>
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
