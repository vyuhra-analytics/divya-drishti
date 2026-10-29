import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BROKER_LABELS, familyCsv, fyOf, maskCode, SEGMENT_LABELS, statementHtml, statementRows, toCsv, type AccountantStatement, type ContractRow, type CoverageView, type CrossTab, type DayRow, type FamilyAccount, type FamilyMember, type DayRisk, type FyHeadline, type GroupRow, type Habits, type Insights, type LastDay, type MonthlyView, type MonthRow, type Segment, type Summary } from "@drishti/shared";
import { allCards, ByMember, fyCards, HabitsCard, KpiTrio, RecentDays, RiskCard, YearSoFar } from "./FamilyExtras";
import { apiUrl } from "./settings";
import { Button, Input, Select, Switch, Tabs, TabsList, TabsTrigger } from "./ui";
import type { Widget } from "./workspace";

// The household's broker statements: upload a Zerodha Console P&L or tradebook and the file finds its account by client id (a new one is created under an
// "Unassigned" member when none exists, to be renamed or moved to the right person later), then read realised P&L, charges and the net by financial year,
// member, account, segment, underlying and month. A record-keeper: nothing here places an order. The hide switch masks names and amounts on screen.
// Three tabs: Overview (totals and cuts), Months (from the tradebook) and Files and people (upload, name, map, remove).

interface ImportRow {
  id: number;
  accountId: number;
  kind: "pnl" | "tradebook";
  segment: Segment;
  periodFrom: string;
  periodTo: string;
  fileName: string;
  importedAt: string;
  rows: number;
  problems: string[];
}
interface Overview {
  members: FamilyMember[];
  accounts: FamilyAccount[];
  imports: ImportRow[];
  coverage: CoverageView;
  /** every year or period a statement can be exported for */
  statementPeriods: string[];
}
interface Report {
  summary: Summary;
  monthly: MonthlyView;
  lastDay?: LastDay | null;
  fyHeadline?: FyHeadline | null;
  risk?: DayRisk | null;
  habits?: Habits | null;
  insights: Insights | null;
  yearBySegment: CrossTab;
  memberByYear: CrossTab;
}
interface Outcome {
  file: string;
  ok: boolean;
  /** a file that was already imported: nothing to do, shown as a plain note rather than a failure */
  skipped?: boolean;
  text: string;
  canAccept?: boolean;
  bytes?: ArrayBuffer;
}
type Tab = "overview" | "contracts" | "months" | "setup";
type Cut = "account" | "segment" | "underlying" | "charges" | "yearseg" | "memberyear";
type SortKey = "symbol" | "segment" | "member" | "fy" | "quantity" | "realized" | "charges" | "net";

const HIDE_KEY = "drishti-family-hide";
const VIEW_KEY = "drishti-family-view";
const TABS: Tab[] = ["overview", "contracts", "months", "setup"];
const CUTS: Cut[] = ["account", "segment", "underlying", "charges", "yearseg", "memberyear"];
/** how many contract rows are drawn at first and each time "Show more" is pressed: the list can be thousands long, so it is drawn in pieces */
const FIRST_ROWS = 100;
const MORE_ROWS = 200;

interface ViewState {
  tab?: Tab;
  period: string;
  memberId: string;
  segment: string;
  cut: Cut;
}
/** The view the owner left: tab, year, member, segment and break-down, so a reload comes back to the same screen. A damaged or blocked store gives the defaults. */
function loadView(): ViewState {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}");
    return { tab: TABS.includes(v.tab) ? v.tab : undefined, period: typeof v.period === "string" ? v.period : "", memberId: typeof v.memberId === "string" ? v.memberId : "", segment: typeof v.segment === "string" ? v.segment : "", cut: CUTS.includes(v.cut) ? v.cut : "account" };
  } catch {
    return { period: "", memberId: "", segment: "", cut: "account" };
  }
}
const inr = (n: number, dp = 2) => n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl()}/family${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(typeof body?.message === "string" ? body.message : `HTTP ${res.status}`), { status: res.status });
  return body as T;
}
const post = <T,>(path: string, body: unknown) => call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) => call<T>(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** One row of the contracts table. Memoised: a keystroke in the search box or a change elsewhere on the screen redraws only the rows whose contract, name or masking changed. */
const ContractLine = memo(function ContractLine({ c, member, hide }: { c: ContractRow; member: string; hide: boolean }) {
  const money = (n: number) => (hide ? "••••" : inr(n));
  const signed = (n: number) => <span className={n > 0 ? "up" : n < 0 ? "down" : ""}>{money(n)}</span>;
  return (
    <tr>
      <td title={c.file}>{c.symbol}</td>
      <td>{SEGMENT_LABELS[c.segment]}</td>
      <td>{member}</td>
      <td>{c.fy}</td>
      <td className="num">{c.quantity}</td>
      <td className="num">{signed(c.realized)}</td>
      <td className="num">{c.charges === undefined ? <span className="muted" title="This statement gives charges for the whole period, not per contract">—</span> : money(c.charges)}</td>
      <td className="num">{c.net === undefined ? <span className="muted">—</span> : signed(c.net)}</td>
    </tr>
  );
});

/** A diverging bar for a profit or loss, scaled to the largest in its table. */
function Bar({ value, max }: { value: number; max: number }) {
  const w = max > 0 ? Math.min(100, (Math.abs(value) / max) * 100) : 0;
  return (
    <span className="fam-bar" aria-hidden="true">
      <i className={value >= 0 ? "up" : "down"} style={{ width: `${w}%` }} />
    </span>
  );
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MON[Number(m.slice(5, 7)) - 1] ?? m.slice(5)} ${m.slice(2, 4)}`;

/**
 * The net of each month as bars, with the running total as a line. A month can hold an exact part (from a tradebook's dated trades) and an estimated part
 * (contracts of statements without dates, placed by their expiry month): they are drawn apart, the estimate lighter and dashed. Values are left out of the
 * picture while amounts are hidden.
 */
function MonthChart({ months, hide }: { months: MonthRow[]; hide: boolean }) {
  const n = months.length;
  const step = 44;
  const W = Math.max(320, n * step);
  const H = 180;
  const top = 12;
  const bottom = 24;
  const mid = top + (H - top - bottom) / 2;
  let run = 0;
  const cum = months.map((m) => (run += m.net));
  const exact = (m: MonthRow) => m.realized - m.charges;
  const est = (m: MonthRow) => m.est.realized - m.est.charges;
  const maxAbs = Math.max(1, ...months.flatMap((m) => [Math.abs(exact(m)), Math.abs(est(m))]), ...cum.map(Math.abs));
  const k = (mid - top) / maxAbs;
  const x = (i: number) => (W / n) * (i + 0.5);
  const bw = Math.min(26, (W / n) * 0.6);
  return (
    <svg className="fam-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={hide ? "Net by month (values hidden)" : `Net by month, ${n} months`}>
      <line x1="0" x2={W} y1={mid} y2={mid} className="fam-zero" />
      {months.map((m, i) => {
        const both = m.closes > 0 && m.est.contracts > 0;
        const w = both ? bw / 2 - 1 : bw;
        const bar = (v: number, dx: number, estimated: boolean) => (
          <rect x={x(i) + dx} y={v >= 0 ? mid - v * k : mid} width={w} height={Math.max(1, Math.abs(v) * k)} className={`${v >= 0 ? "fam-up" : "fam-down"}${estimated ? " fam-est" : ""}`} rx="2">
            {!hide && <title>{`${m.month}${estimated ? " (estimated by expiry month)" : " (exact)"}: ${inr(v)}`}</title>}
          </rect>
        );
        return (
          <g key={m.month}>
            {m.closes > 0 && bar(exact(m), both ? -w - 1 : -w / 2, false)}
            {m.est.contracts > 0 && bar(est(m), both ? 1 : -w / 2, true)}
            <text x={x(i)} y={H - 8} textAnchor="middle" className="fam-axis">{monthLabel(m.month)}</text>
          </g>
        );
      })}
      {n > 1 && <polyline className="fam-cum" fill="none" points={cum.map((c, i) => `${x(i)},${mid - c * k}`).join(" ")} />}
      {n > 1 && cum.map((c, i) => <circle key={i} cx={x(i)} cy={mid - c * k} r="2.5" className="fam-cumdot">{!hide && <title>{`running total ${inr(c)}`}</title>}</circle>)}
    </svg>
  );
}

/**
 * One square per day of a financial year, April to March, a block of week columns per month, rows Monday to Sunday: green where the day's result was a profit,
 * red where it was a loss, the shade by how big it was against the other days shown, grey where nothing was closed. A day placed by a contract's expiry date
 * (from a statement without dates) is an estimate and is drawn with a dashed edge. Amounts are left out of the tooltips while they are hidden.
 */
function CalendarHeat({ days, hide }: { days: DayRow[]; hide: boolean }) {
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const fys = useMemo(() => [...new Set(days.map((d) => fyOf(d.date)))].sort(), [days]);
  // shade by rank among the days shown: a few huge days must not turn every other day pale
  const sizes = useMemo(() => days.map((d) => Math.abs(d.net)).filter((v) => v > 0).sort((a, b) => a - b), [days]);
  const level = (v: number) => {
    const at = sizes.findIndex((x) => x >= Math.abs(v));
    const q = (at < 0 ? sizes.length - 1 : at) / Math.max(1, sizes.length - 1);
    return q <= 0.25 ? 1 : q <= 0.5 ? 2 : q <= 0.75 ? 3 : 4;
  };
  const cell = 12;
  const step = 15;
  const monthGap = 14;
  return (
    <div className="fam-heat">
      {fys.map((fy) => {
        const y0 = Number(fy.slice(0, 4));
        let x = 0;
        const blocks: { label: string; x: number; cells: { date: string; col: number; row: number }[] }[] = [];
        for (let i = 0; i < 12; i++) {
          const m = (3 + i) % 12;
          const year = m >= 3 ? y0 : y0 + 1;
          const offset = (new Date(Date.UTC(year, m, 1)).getUTCDay() + 6) % 7; // Monday is the first row
          const count = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
          const cols = Math.ceil((offset + count) / 7);
          const cells = Array.from({ length: count }, (_, d) => ({ date: `${year}-${String(m + 1).padStart(2, "0")}-${String(d + 1).padStart(2, "0")}`, col: Math.floor((offset + d) / 7), row: (offset + d) % 7 }));
          blocks.push({ label: MON[m], x, cells });
          x += cols * step + monthGap;
        }
        const W = x - monthGap;
        const H = 7 * step + 20;
        const mine = days.filter((d) => fyOf(d.date) === fy);
        const gain = mine.filter((d) => d.net > 0).length;
        const loss = mine.filter((d) => d.net < 0).length;
        const estimated = mine.filter((d) => d.est.contracts > 0).length;
        return (
          <section key={fy} className="fam-heat-year">
            <header>
              <b>{fy}</b>
              <small className="muted">
                {hide ? "••" : `${gain} profit days, ${loss} loss days${estimated > 0 ? `, ${estimated} placed by expiry` : ""}`} · {fy.slice(0, 4)}-04-01 to {y0 + 1}-03-31
              </small>
            </header>
            <svg className="fam-heat-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMin meet" role="img" aria-label={hide ? `Daily results for ${fy} (values hidden)` : `Daily results for ${fy}: ${gain} profit days, ${loss} loss days`}>
              {blocks.map((b) => (
                <g key={b.label} transform={`translate(${b.x},2)`}>
                  {b.cells.map((c) => {
                    const d = byDate.get(c.date);
                    const cls = d && d.net !== 0 ? `${d.net > 0 ? "up" : "down"} l${level(d.net)}${d.est.contracts > 0 ? " est" : ""}` : "none";
                    return (
                      <rect key={c.date} x={c.col * step} y={c.row * step} width={cell} height={cell} rx="2" className={`fam-hm ${cls}`}>
                        {!hide && <title>{d ? `${c.date}: ${inr(d.net)} · ${d.est.contracts > 0 && d.closes === 0 ? `estimated, ${d.est.contracts} contract${d.est.contracts === 1 ? "" : "s"} expiring` : d.est.contracts > 0 ? `${d.closes} closed and ${d.est.contracts} placed by expiry` : `${d.closes} closed`}` : `${c.date}: nothing closed`}</title>}
                      </rect>
                    );
                  })}
                  <text x="0" y={7 * step + 12} className="fam-axis">{b.label.toUpperCase()}</text>
                </g>
              ))}
            </svg>
          </section>
        );
      })}
      <p className="fam-legend">
        <span>loss</span>
        {[4, 3, 2, 1].map((l) => <i key={`d${l}`} className={`fam-hmkey down l${l}`} />)}
        <i className="fam-hmkey none" />
        {[1, 2, 3, 4].map((l) => <i key={`u${l}`} className={`fam-hmkey up l${l}`} />)}
        <span>profit</span>
        <span><i className="fam-hmkey up l4 est" /> dashed: placed by contract expiry date (an estimate)</span>
        <span><i className="fam-hmkey none" /> nothing closed</span>
      </p>
    </div>
  );
}

/** The net of each financial year as bars, one per segment, side by side. Values are left out of the picture while amounts are hidden. */
function GroupedChart({ tab, hide }: { tab: CrossTab; hide: boolean }) {
  const n = tab.rows.length;
  const m = Math.max(1, tab.cols.length);
  const W = Math.max(320, n * (m * 26 + 34));
  const H = 190;
  const top = 12;
  const bottom = 24;
  const mid = top + (H - top - bottom) / 2;
  const maxAbs = Math.max(1, ...tab.rows.flatMap((r) => tab.cols.map((c) => Math.abs(tab.cells[r.key]?.[c.key]?.net ?? 0))));
  const k = (mid - top) / maxAbs;
  const gw = W / n;
  const bw = Math.min(24, (gw * 0.8) / m);
  return (
    <svg className="fam-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={hide ? "Net by financial year (values hidden)" : `Net by financial year, ${n} years`}>
      <line x1="0" x2={W} y1={mid} y2={mid} className="fam-zero" />
      {tab.rows.map((r, i) => (
        <g key={r.key}>
          {tab.cols.map((c, j) => {
            const v = tab.cells[r.key]?.[c.key]?.net;
            if (v === undefined) return null;
            const x = i * gw + gw / 2 + (j - (m - 1) / 2) * (bw + 3) - bw / 2;
            return (
              <rect key={c.key} x={x} y={v >= 0 ? mid - v * k : mid} width={bw} height={Math.max(1, Math.abs(v) * k)} className={`fam-s${j % 4}`} rx="2">
                {!hide && <title>{`${r.label}, ${c.label}: ${inr(v)}`}</title>}
              </rect>
            );
          })}
          <text x={i * gw + gw / 2} y={H - 8} textAnchor="middle" className="fam-axis">{r.label.length > 9 ? r.label.slice(2, 7) : r.label}</text>
        </g>
      ))}
    </svg>
  );
}

const heading = (title: string) => title.replace(/^By /, "").replace(/^./, (c) => c.toUpperCase());

export function FamilyWidget(_: { widget: Widget }) {
  const [data, setData] = useState<Overview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [busy, setBusy] = useState(false);
  const [hide, setHide] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [initial] = useState(loadView);
  const [period, setPeriod] = useState(initial.period);
  const [memberId, setMemberId] = useState(initial.memberId);
  const [segment, setSegment] = useState(initial.segment);
  const [reveal, setReveal] = useState<Set<number>>(new Set());
  const [newMember, setNewMember] = useState("");
  const [tab, setTab] = useState<Tab | null>(initial.tab ?? null);
  const [cut, setCut] = useState<Cut>(initial.cut);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "realized", dir: 1 });
  const [shown, setShown] = useState(FIRST_ROWS);
  const [stMember, setStMember] = useState("");
  const [stYear, setStYear] = useState("");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [contractsData, setContractsData] = useState<{ rows: ContractRow[]; total: number; query: string } | null>(null);
  const [contractsError, setContractsError] = useState<string | null>(null);
  /** report requests in flight: while any is, the numbers on screen are the previous selection's and are dimmed */
  const [pending, setPending] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef({ overview: 0, report: 0, contracts: 0 });
  const aborts = useRef<{ report?: AbortController; contracts?: AbortController }>({});

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (period) q.set("period", period);
    if (memberId) q.set("member", memberId);
    if (segment) q.set("segment", segment);
    const s = q.toString();
    return s ? `?${s}` : "";
  }, [period, memberId, segment]);

  // the view is remembered, so a reload (or the next visit) comes back to the same tab, year, member and break-down
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ tab, period, memberId, segment, cut }));
    } catch {
      /* not remembered */
    }
  }, [tab, period, memberId, segment, cut]);

  // Three requests, each answering only its own question and each ignoring an answer that has been overtaken by a newer one: the members and files change only when
  // something is added or removed; the summary follows the filters; the contracts are fetched only while the Contracts tab is open.
  const loadOverview = useCallback(async () => {
    const mine = ++seq.current.overview;
    try {
      const o = await call<Overview>("");
      if (mine !== seq.current.overview) return;
      // an API that has not been restarted since an update answers without the newer fields: the screen shows what it has instead of failing
      setData({ ...o, coverage: o.coverage ?? { years: [], rows: [] }, statementPeriods: o.statementPeriods ?? [] });
      setError(null);
    } catch (e) {
      if (mine === seq.current.overview) setError((e as Error).message);
    }
  }, []);

  const loadReport = useCallback(async () => {
    const mine = ++seq.current.report;
    aborts.current.report?.abort();
    const ac = new AbortController();
    aborts.current.report = ac;
    setPending((n) => n + 1);
    try {
      const r = await call<Report>(`/summary${query}`, { signal: ac.signal });
      if (mine !== seq.current.report) return;
      const monthly = { ...r.monthly, days: r.monthly.days ?? [], months: r.monthly.months.map((m) => ({ ...m, est: m.est ?? { realized: 0, charges: 0, contracts: 0 } })), unplaced: r.monthly.unplaced ?? { contracts: 0, realized: 0 } };
      setReport({ ...r, lastDay: r.lastDay ? { ...r.lastDay, recent: r.lastDay.recent ?? [], byMember: r.lastDay.byMember ?? [] } : (r.lastDay ?? null), fyHeadline: r.fyHeadline ?? null, risk: r.risk ?? null, habits: r.habits ?? null, monthly, insights: r.insights ?? null, yearBySegment: r.yearBySegment ?? { rows: [], cols: [], cells: {} }, memberByYear: r.memberByYear ?? { rows: [], cols: [], cells: {} } });
      setError(null);
    } catch (e) {
      if ((e as Error).name !== "AbortError" && mine === seq.current.report) setError((e as Error).message);
    } finally {
      setPending((n) => n - 1);
    }
  }, [query]);

  const loadContracts = useCallback(async () => {
    const mine = ++seq.current.contracts;
    aborts.current.contracts?.abort();
    const ac = new AbortController();
    aborts.current.contracts = ac;
    try {
      const r = await call<{ contracts: ContractRow[]; total: number }>(`/contracts${query}`, { signal: ac.signal });
      if (mine !== seq.current.contracts) return;
      setContractsData({ rows: r.contracts ?? [], total: r.total ?? 0, query });
      setContractsError(null);
    } catch (e) {
      if ((e as Error).name !== "AbortError" && mine === seq.current.contracts) setContractsError((e as Error).message);
    }
  }, [query]);

  /** after something was added, moved or removed: everything that depends on the files is read again */
  const reload = useCallback(async () => {
    setContractsData(null);
    await Promise.all([loadOverview(), loadReport(), tab === "contracts" ? loadContracts() : Promise.resolve()]);
  }, [loadOverview, loadReport, loadContracts, tab]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);
  useEffect(() => {
    void loadReport();
  }, [loadReport]);
  useEffect(() => {
    if (tab === "contracts" && contractsData?.query !== query) void loadContracts();
  }, [tab, query, contractsData?.query, loadContracts]);
  // the list starts again from its first rows when the selection changes, not when its contracts arrive (that would undo a press of "Show more")
  useEffect(() => {
    setShown(FIRST_ROWS);
  }, [query]);
  // a remembered member or year that no longer exists would show an empty screen with nothing to explain it
  useEffect(() => {
    if (!data) return;
    if (memberId && !data.members.some((m) => String(m.id) === memberId)) setMemberId("");
    if (period && data.statementPeriods.length > 0 && !data.statementPeriods.includes(period)) setPeriod("");
  }, [data, memberId, period]);

  // every contract of the open selection, searched and sorted; recomputed only when what it depends on changes, never on an unrelated redraw
  const contractList = useMemo(() => {
    const rows = contractsData?.rows ?? [];
    const needle = q.trim().toLowerCase();
    const mname = (id: number) => (data?.members.find((m) => m.id === id)?.nickname ?? "").toLowerCase();
    const list = rows.filter((c) => !needle || c.symbol.toLowerCase().includes(needle) || c.underlying.toLowerCase().includes(needle) || (!hide && mname(c.memberId).includes(needle)));
    const val = (c: ContractRow): number | string => (sort.key === "member" ? mname(c.memberId) : sort.key === "segment" ? c.segment : sort.key === "symbol" ? c.symbol : sort.key === "fy" ? c.fy : (c[sort.key] ?? Number.POSITIVE_INFINITY));
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [contractsData, q, sort, hide, data?.members]);

  const toggleHide = () => {
    const next = !hide;
    setHide(next);
    try {
      localStorage.setItem(HIDE_KEY, next ? "1" : "0");
    } catch {
      /* not remembered */
    }
  };

  // names and amounts, masked while the switch is on
  const memberIndex = useMemo(() => new Map((data?.members ?? []).map((m, i) => [m.id, i + 1])), [data]);
  const memberName = (id: number) => (hide ? `Member ${memberIndex.get(id) ?? "?"}` : (data?.members.find((m) => m.id === id)?.nickname ?? "?"));
  const accountName = (a: FamilyAccount) => `${memberName(a.memberId)} · ${BROKER_LABELS[a.broker]} · ${hide ? `account ${a.id}` : a.label}`;
  const money = (n: number, dp = 2) => (hide ? "••••" : inr(n, dp));
  const signed = (n: number, dp = 2) => <span className={n > 0 ? "up" : n < 0 ? "down" : ""}>{money(n, dp)}</span>;
  const fmt = { hide, money: (n: number) => money(n), signed: (n: number) => signed(n) };

  const upload = async (files: FileList | null, accept = false, again?: Outcome) => {
    const list = again ? [{ name: again.file, buf: again.bytes! }] : await Promise.all([...(files ?? [])].map(async (f) => ({ name: f.name, buf: await f.arrayBuffer() })));
    if (!list.length) return;
    setBusy(true);
    const out: Outcome[] = [];
    for (const [i, f] of list.entries()) {
      setProgress(`Reading ${i + 1} of ${list.length}${hide ? "" : `: ${f.name}`}`);
      try {
        const r = await call<{ kind: string; segment: Segment; segments?: Segment[]; periodFrom: string; periodTo: string; rows: number; newAccount: boolean; client: string; filedUnder?: string; replaced?: { fileName: string; rows: number }[] }>(`/import?name=${encodeURIComponent(f.name)}${accept ? "&accept=1" : ""}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f.buf });
        out.push({ file: f.name, ok: true, text: `${r.kind === "pnl" ? "Statement" : "Tradebook"} ${(r.segments ?? [r.segment]).map((x) => SEGMENT_LABELS[x]).join(" + ")} ${r.periodFrom} to ${r.periodTo}: ${r.rows} ${r.kind === "pnl" ? "symbols" : "fills"} read${r.newAccount ? (r.filedUnder ? `, new account for client ${r.client}, filed under ${hide ? "the member of that name" : r.filedUnder}` : `, new account for client ${r.client} (name the person below)`) : ""}${r.replaced?.length ? `. Replaced the earlier ${r.replaced.map((x) => `${x.fileName} (${x.rows})`).join(", ")}, which this one covers` : ""}` });
      } catch (e) {
        const msg = (e as Error).message;
        const skipped = /exact file is already imported/.test(msg);
        out.push({ file: f.name, ok: false, ...(skipped ? { skipped: true } : {}), text: skipped ? "already imported, skipped (nothing was counted twice). Remove it from the list below to import it again." : msg, canAccept: /does not add up/.test(msg), bytes: f.buf });
      }
    }
    setOutcomes((prev) => [...out, ...prev.filter((p) => !out.some((o) => o.file === p.file))].slice(0, 12));
    setProgress(null);
    setBusy(false);
    if (input.current) input.current.value = "";
    await reload();
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
    await reload();
  };

  if (error && !data) return <p className="down" role="alert">{error}</p>;
  if (!data || !report) return <p className="muted">Loading…</p>;
  const { summary: s, monthly } = report;
  const hasData = s.imports.length > 0;
  const active: Tab = tab ?? (hasData ? "overview" : "setup");
  // only members that hold an account need a name: an empty one is just a leftover, removable in Files and people
  const unassigned = data.members.filter((m) => /^Unassigned \d+$/.test(m.nickname) && data.accounts.some((a) => a.memberId === m.id));

  /** a table of totals by some grouping; `charges` false for a grouping a statement cannot split (underlying) */
  const rowsTable = (title: string, rows: GroupRow[], label: (r: GroupRow) => string, charges = true, partial = false) => {
    if (rows.length === 0) return null;
    const max = Math.max(1, ...rows.map((r) => Math.abs(charges && !(partial && !r.chargesComplete) ? r.net : r.realized)));
    return (
      <div className="fam-scroll">
        {title && <h2>{title}</h2>}
        <table className="fam-table">
          <thead>
            <tr>
              <th>{heading(title || "Name")}</th>
              <th className="num">Realised</th>
              {charges && <th className="num">Charges</th>}
              {charges && <th className="num">Net</th>}
              <th className="fam-barcol" />
              <th className="num" title="winning and losing symbols">W / L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{label(r)}</td>
                <td className="num">{signed(r.realized)}</td>
                {charges && <td className="num" title={partial && !r.chargesComplete ? "Only the contracts whose statement gives charges per contract (Kotak's) are counted here" : undefined}>{money(r.charges)}{partial && !r.chargesComplete ? "*" : ""}</td>}
                {charges && <td className="num">{partial && !r.chargesComplete ? <span className="muted">—</span> : signed(r.net)}</td>}
                <td><Bar value={charges && !(partial && !r.chargesComplete) ? r.net : r.realized} max={max} /></td>
                <td className="num muted">{r.winners} / {r.losers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  /** things that need the owner's attention, each with where to act */
  const alerts: { key: string; tone: "warn" | "info"; title: string; text: string }[] = [];
  if (unassigned.length > 0)
    alerts.push({ key: "unassigned", tone: "info", title: unassigned.length === 1 ? "A member was created from a file" : `${unassigned.length} members were created from files`, text: hide ? "Turn off Hide names and amounts, then give each one a name or move the account to someone you already added." : `${unassigned.map((m) => `"${m.nickname}"`).join(", ")}: type the person's name over it, or move the account to someone you already added.` });
  for (const r of monthly.reconciliation.filter((x) => !x.ok)) {
    const imp = data.imports.find((i) => i.id === r.importId);
    const acc = data.accounts.find((a) => a.id === imp?.accountId);
    const syms = r.differences.map((d) => (hide ? "a symbol" : `${d.symbol} (${inr(d.difference)})`)).join(", ");
    alerts.push({ key: `mm-${r.importId}`, tone: "warn", title: `Carried-in positions${acc && !hide ? ` in ${accountName(acc)}` : ""}`, text: `${r.differences.length} symbol${r.differences.length === 1 ? "" : "s"} in ${hide ? "a statement" : r.fileName} ${r.differences.length === 1 ? "has" : "have"} no matching trades in the tradebook: ${syms}. They were probably opened before the tradebook starts, so add the tradebook for the earlier period. Until then this statement keeps its own period instead of being cut into financial years.` });
  }
  // statements without dates are not "missing" months: their contracts are placed by expiry month, which the Months tab labels as an estimate
  const brokerOf = (importId: number) => data.accounts.find((a) => a.id === data.imports.find((i) => i.id === importId)?.accountId)?.broker;
  const noDates = [...new Set(monthly.withoutTradebook.map((w) => w.importId))];
  const zerodhaNoBook = monthly.withoutTradebook.filter((w) => brokerOf(w.importId) !== "kotak");
  if (noDates.length > 0)
    alerts.push({
      key: "est-months",
      tone: "info",
      title: "Some months are estimated",
      text: `${noDates.length} statement${noDates.length === 1 ? " has" : "s have"} no trade dates, so each contract is placed in the month it expires (the real trade can be a few weeks earlier). ${zerodhaNoBook.length > 0 ? "A Zerodha tradebook for the same period gives exact months. " : ""}${monthly.withoutTradebook.some((w) => brokerOf(w.importId) === "kotak") ? "For Kotak, add its Transaction Statement (Profile → Reports → Transaction Statement): it has every trade with its date." : ""}`.trim(),
    });

  const alertCard = (a: (typeof alerts)[number]) => (
    <div key={a.key} className={`fam-alert ${a.tone}`} role={a.tone === "warn" ? "alert" : "status"}>
      <div>
        <b>{a.title}</b>
        <p>{a.text}</p>
      </div>
      {a.key !== "est-months" && <Button size="sm" onClick={() => setTab("months")}>See months</Button>}
      {a.key === "est-months" && <Button size="sm" onClick={() => setTab("setup")}>Add files</Button>}
    </div>
  );
  // one thing to check is shown as it is; several fold into one line that opens, so the numbers stay at the top
  const alertBlock =
    alerts.length === 0 ? null : (
      <details className="fam-alerts no-drag">
        <summary>
          {alerts.some((a) => a.tone === "warn") && <span className="fam-dot" aria-hidden="true" />}
          <b>{alerts.length === 1 ? alerts[0].title : `${alerts.length} things to check`}</b>
          {alerts.length > 1 && <small>{alerts.map((a) => a.title).join(" · ")}</small>}
        </summary>
        {alerts.map(alertCard)}
      </details>
    );

  /** the numbers on screen as a CSV file named by what it covers; names come from the members, the client id is never in it */
  const download = () => {
    const accountLabel = (id: number) => {
      const a = data.accounts.find((x) => x.id === id);
      return a ? `${data.members.find((m) => m.id === a.memberId)?.nickname ?? "?"} - ${BROKER_LABELS[a.broker]} - ${a.label}` : String(id);
    };
    const csv = familyCsv(report, { member: (id) => data.members.find((m) => m.id === id)?.nickname ?? String(id), account: accountLabel });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `family-pnl${period ? `-${period}` : ""}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ---- the accountant's statement: fetched for one member and year, then opened as a printable page or saved as CSV
  const stMemberId = stMember || String(data.members.find((m) => data.accounts.some((a) => a.memberId === m.id))?.id ?? "");
  const stPeriod = stYear || data.statementPeriods[data.statementPeriods.length - 1] || "";
  const statement = async (as: "csv" | "page") => {
    const memberName = data.members.find((m) => m.id === Number(stMemberId))?.nickname ?? "";
    await act(async () => {
      const st = await call<AccountantStatement>(`/statement?member=${stMemberId}&period=${encodeURIComponent(stPeriod)}`);
      const url = URL.createObjectURL(as === "csv" ? new Blob([toCsv(statementRows(st, memberName))], { type: "text/csv;charset=utf-8" }) : new Blob([statementHtml(st, memberName)], { type: "text/html;charset=utf-8" }));
      if (as === "csv") {
        const link = document.createElement("a");
        link.href = url;
        link.download = `statement-${stPeriod.replace(/ /g, "")}-${memberName.replace(/[^A-Za-z0-9]+/g, "_")}.csv`;
        link.click();
      } else window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  };

  // ---- sorting and saving the contracts
  const sortBy = (key: SortKey) => setSort((cur) => (cur.key === key ? { key, dir: (cur.dir * -1) as 1 | -1 } : { key, dir: key === "realized" || key === "net" || key === "charges" ? 1 : -1 }));
  const sortHead = (key: SortKey, text: string, num = false) => (
    <th className={num ? "num" : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="fam-sort" onClick={() => sortBy(key)}>{text}{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</button>
    </th>
  );
  const downloadContracts = () => {
    const rows: (string | number)[][] = [["Contract", "Segment", "Member", "Year", "Quantity", "Realised (before charges)", "Charges (where given per contract)", "Net (where charges are known)"]];
    for (const c of contractList) rows.push([c.symbol, SEGMENT_LABELS[c.segment], data.members.find((m) => m.id === c.memberId)?.nickname ?? "", c.fy, c.quantity, c.realized, c.charges ?? "", c.net ?? ""]);
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "family-contracts.csv";
    link.click();
    URL.revokeObjectURL(url);
  };


  return (
    <div className={`family${pending > 0 ? " fam-updating" : ""}`} aria-busy={pending > 0}>
      <div className="fam-top no-drag">
        <Tabs value={active} onValueChange={(v) => setTab(v as Tab)} className="fam-tabs">
          <TabsList aria-label="Family sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="contracts">Contracts</TabsTrigger>
            <TabsTrigger value="months">Months</TabsTrigger>
            <TabsTrigger value="setup">Files and people</TabsTrigger>
          </TabsList>
        </Tabs>
        <label>
          Year
          <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">All years</option>
            {(data.statementPeriods.length > 0 ? data.statementPeriods : s.byPeriod.map((p) => p.key)).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </Select>
        </label>
        <label>
          Member
          <Select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">Everyone</option>
            {data.members.map((m) => (
              <option key={m.id} value={m.id}>{memberName(m.id)}</option>
            ))}
          </Select>
        </label>
        <label>
          Segment
          <Select value={segment} onChange={(e) => setSegment(e.target.value)}>
            <option value="">All</option>
            {(Object.keys(SEGMENT_LABELS) as Segment[]).map((k) => (
              <option key={k} value={k}>{SEGMENT_LABELS[k]}</option>
            ))}
          </Select>
        </label>
        {hasData && (
          <Button size="sm" onClick={download} disabled={hide} title={hide ? "Turn off Hide names and amounts to export (the file carries names and amounts)" : "Download what is on screen as a CSV file"}>
            Download CSV
          </Button>
        )}
        {report?.lastDay && <span className="fam-asof" title="The newest dated trade in what is selected: later days are not loaded">Trades to {new Date(`${report.lastDay.asOf}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</span>}
        <label className="fam-hide" title="Hides names and amounts on screen. It is not encryption.">
          <Switch checked={hide} onCheckedChange={() => toggleHide()} aria-label="Hide names and amounts" /> Hide names and amounts
        </label>
      </div>
      {error && <p className="down" role="alert">{error}</p>}
      {active !== "setup" && alertBlock}

      {active === "overview" &&
        (!hasData ? (
          <p className="muted">No statement yet, so there is nothing to total. Add a Zerodha P&amp;L file in <b>Files and people</b>. A tradebook alone gives the months but not the charges.</p>
        ) : (
          <>
            {!period && report.fyHeadline && <YearSoFar h={report.fyHeadline} cards={fyCards(report.fyHeadline, report.lastDay, monthly.days)} day={report.lastDay?.date} fmt={fmt} />}
            {!period && report.fyHeadline && s.byPeriod.length > 1 && <h2 className="fam-allyears">All years together</h2>}
            <KpiTrio cards={allCards(s.totals, s.byPeriod, report.lastDay, monthly.days)} day={report.lastDay?.date} fmt={fmt} />
            <p className="fam-meta">
              <span title="Open positions as the broker marked them at the end of the statement; not part of the net">Unrealised (reported) {signed(s.totals.unrealized)}</span>
              <span title="The sum of each symbol's absolute net result. The true turnover uses every trade, so this is a lower bound; ask your accountant for the filing figure.">F&amp;O turnover, at least {money(s.totals.turnoverAtLeast, 0)}</span>
              <span>{s.totals.symbols} symbols traded</span>
            </p>
            {(() => {
              const d = report.lastDay;
              const todayIst = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
              const when = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
              if (!d)
                return (
                  <div className="fam-card" data-testid="fam-lastday">
                    <b>Last trading day</b>
                    <p className="muted">No dated trades are loaded, so there is no trading day to show. A Zerodha tradebook or Kotak's Transaction Statement carries the dates; a statement alone does not.</p>
                  </div>
                );
              const acct = (id: number) => {
                const a = data?.accounts.find((x) => x.id === id);
                return a ? accountName(a) : "?";
              };
              return (
                <div className="fam-card" data-testid="fam-lastday">
                  <b>Last trading day</b> <span className="muted">{when(d.date)}</span>
                  <div className="fam-lastday-net">{signed(d.net)}</div>
                  <p className="muted">
                    {hide ? "••" : `realised ${inr(d.realized)} less charges ${inr(d.charges)} · ${d.closes} position${d.closes === 1 ? "" : "s"} closed`}
                    {d.closes === 0 && !hide ? " (only costs: positions were opened, none closed)" : ""}
                  </p>
                  <p className="muted">
                    {d.previous ? <>Trading day before, {when(d.previous.date)}: {signed(d.previous.net)}. </> : null}
                    {new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", timeZone: "UTC" })} so far: {signed(d.monthToDate)}.
                  </p>
                  <RecentDays days={d.recent ?? []} hide={hide} />
                  <ByMember rows={d.byMember ?? []} name={memberName} fmt={fmt} />
                  {(d.byAccount.length > 1 || d.bySegment.length > 1) && (
                    <ul className="fam-lastday-split">
                      {d.byAccount.length > 1 && d.byAccount.map((r) => <li key={`a${r.accountId}`}>{acct(r.accountId)}: {signed(r.net)}</li>)}
                      {d.bySegment.length > 1 && d.bySegment.map((r) => <li key={`s${r.segment}`}>{SEGMENT_LABELS[r.segment]}: {signed(r.net)}</li>)}
                    </ul>
                  )}
                  <p className="muted">
                    Trades loaded up to {when(d.asOf)}.{" "}
                    {d.asOf < todayIst
                      ? `Nothing is loaded after that, so later days are not shown: add newer statements and a tradebook.`
                      : d.date < d.asOf
                        ? "No position closed and no cost was booked after the day above."
                        : ""}{" "}
                    Realised only: open positions are not included.
                  </p>
                </div>
              );
            })()}

            {report.insights && (() => {
              const i = report.insights;
              const pct = (v: number | null) => (hide || v === null ? "••" : `${(v * 100).toFixed(0)}%`);
              const times = (v: number | null) => (hide || v === null ? "••" : `${v.toFixed(2)}×`);
              const maxLoss = Math.max(1, ...i.worst.map((r) => Math.abs(r.realized)), ...i.best.map((r) => r.realized));
              const list = (rows: ContractRow[], title: string) => (
                <div>
                  <h3>{title}</h3>
                  {rows.map((r) => (
                    <div key={r.id} className="fam-ct">
                      <span className="fam-ct-name" title={`${SEGMENT_LABELS[r.segment]} · ${r.fy}`}>{r.symbol}</span>
                      <span className="num">{signed(r.realized, 0)}</span>
                      <Bar value={r.realized} max={maxLoss} />
                    </div>
                  ))}
                </div>
              );
              return (
                <section className="fam-card fam-insights">
                  <h2>Why the result is what it is</h2>
                  <p className="fam-verdict">{hide ? "Turn off Hide names and amounts to read this." : i.verdict}</p>
                  <div className="fam-stats">
                    <div title="Contracts that closed in profit as a share of those that closed with a result"><span>Win rate</span><b>{pct(i.winRate)}</b><small>{hide ? "••" : `${i.winners} won, ${i.losers} lost`}</small></div>
                    <div><span>Average win</span><b>{signed(i.avgWin, 0)}</b><small>per winning contract</small></div>
                    <div><span>Average loss</span><b>{signed(i.avgLoss, 0)}</b><small>per losing contract</small></div>
                    <div title="The average win divided by the size of the average loss. Under 1×, the typical loss is bigger than the typical win."><span>Win size ÷ loss size</span><b>{times(i.payoff)}</b><small>under 1× = losses are bigger</small></div>
                    <div title="All the winnings divided by all the losses. Under 1×, more was lost than won, before charges."><span>Winnings ÷ losses</span><b>{times(i.profitFactor)}</b><small>before charges</small></div>
                    <div><span>Per contract</span><b>{signed(i.expectancy, 0)}</b><small>average result</small></div>
                  </div>
                  <p className="muted">
                    {hide ? "••" : `Charges are ${i.chargesOfWinnings === null ? "—" : (i.chargesOfWinnings * 100).toFixed(1) + "% of the winnings"}${i.chargesOfLosses === null ? "" : ` and ${(i.chargesOfLosses * 100).toFixed(1)}% of the losses`}.${i.worstFiveShare === null ? "" : ` The ${Math.min(5, i.losers)} worst contracts hold ${(i.worstFiveShare * 100).toFixed(0)}% of all the losses.`}`}
                  </p>
                  <div className="fam-two">
                    {list(i.worst, "Biggest losses")}
                    {list(i.best, "Biggest wins")}
                  </div>
                  {i.bySegment.length > 1 && (
                    <div className="fam-scroll">
                      <table className="fam-table">
                        <thead>
                          <tr><th>Segment</th><th className="num">Contracts</th><th className="num">Win rate</th><th className="num" title="average win ÷ size of the average loss">Win ÷ loss size</th><th className="num">Winnings ÷ losses</th><th className="num">Realised</th></tr>
                        </thead>
                        <tbody>
                          {i.bySegment.map((sg) => (
                            <tr key={sg.segment}>
                              <td>{SEGMENT_LABELS[sg.segment]}</td>
                              <td className="num">{sg.contracts}</td>
                              <td className="num">{pct(sg.winRate)}</td>
                              <td className="num">{times(sg.payoff)}</td>
                              <td className="num">{times(sg.profitFactor)}</td>
                              <td className="num">{signed(sg.realized, 0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })()}
            {report.risk && <RiskCard r={report.risk} fmt={fmt} />}
            {report.habits && <HabitsCard h={report.habits} fmt={fmt} />}

            <div className="fam-grid">
              <section className="fam-card">
                <h2>Net by financial year</h2>
                {report.yearBySegment.rows.length > 0 ? (
                  <>
                    <GroupedChart tab={report.yearBySegment} hide={hide} />
                    <p className="fam-legend">
                      {report.yearBySegment.cols.map((c, j) => (
                        <span key={c.key}><i className={`fam-s${j % 4}`} /> {c.label}</span>
                      ))}
                    </p>
                  </>
                ) : (
                  <p className="muted">No statement in this selection.</p>
                )}
              </section>
              <section className="fam-card">
                <h2>Members</h2>
                {(() => {
                  const max = Math.max(1, ...s.byMember.map((m) => Math.abs(m.net)));
                  return s.byMember.map((m) => {
                    const accs = data.accounts.filter((a) => a.memberId === Number(m.key)).length;
                    const decided = m.winners + m.losers;
                    return (
                      <div key={m.key} className="fam-member">
                        <div className="fam-member-head">
                          <b>{memberName(Number(m.key))}</b>
                          <span className="num">{signed(m.net)}</span>
                        </div>
                        <Bar value={m.net} max={max} />
                        <small className="muted">
                          {accs} account{accs === 1 ? "" : "s"} · {hide ? "••" : `${decided ? Math.round((m.winners / decided) * 100) : 0}% winning symbols`} · realised {money(m.realized, 0)}, charges {money(m.charges, 0)}
                        </small>
                      </div>
                    );
                  });
                })()}
              </section>
            </div>

            {monthly.months.length > 1 && (
              <section className="fam-card">
                <h2>Net by month</h2>
                <MonthChart months={monthly.months} hide={hide} />
                <p className="fam-legend">
                  <span><i className="fam-up" /> exact</span>
                  <span><i className="fam-up fam-est" /> estimated by contract expiry month</span>
                  <span><i className="fam-line" /> running total</span>
                  <Button size="sm" onClick={() => setTab("months")}>Details</Button>
                </p>
              </section>
            )}

            <section className="fam-card">{rowsTable("Financial year", s.byPeriod, (r) => r.label)}</section>

            <section className="fam-card">
              <Tabs value={cut} onValueChange={(v) => setCut(v as Cut)} className="fam-cuts no-drag">
                <span className="muted">Break down by</span>
                <TabsList aria-label="Break the numbers down by" className="flex-wrap">
                  {(["account", "segment", "underlying", "charges", "yearseg", "memberyear"] as Cut[]).map((c) => (
                    <TabsTrigger key={c} value={c}>
                      {c === "charges" ? "Charges and taxes" : c === "yearseg" ? "Year × segment" : c === "memberyear" ? "Member × year" : c[0].toUpperCase() + c.slice(1)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {cut === "account" &&
                rowsTable("", s.byAccount, (r) => {
                  const a = data.accounts.find((x) => x.id === Number(r.key));
                  return a ? accountName(a) : r.label;
                })}
              {cut === "segment" && rowsTable("", s.bySegment, (r) => SEGMENT_LABELS[r.key as Segment] ?? r.key)}
              {cut === "underlying" && (
                <>
                  {rowsTable("", s.byUnderlying, (r) => r.label, s.underlyingHasCharges, true)}
                  <p className="muted">
                    {s.underlyingHasCharges
                      ? "* Charges are known per contract only for Kotak statements, so an underlying that also has Zerodha contracts shows just those and no net."
                      : "A Zerodha statement gives charges for the whole period, not per symbol, so charges and net are not split by underlying. (Kotak's gives them per contract.)"}
                  </p>
                </>
              )}
              {(cut === "yearseg" || cut === "memberyear") && (() => {
                const tab = cut === "yearseg" ? report.yearBySegment : report.memberByYear;
                const label = (rowKey: string, rowLabel: string) => (cut === "memberyear" ? memberName(Number(rowKey)) : rowLabel);
                return (
                  <div className="fam-scroll">
                    <table className="fam-table">
                      <thead>
                        <tr>
                          <th>{cut === "yearseg" ? "Year" : "Member"}</th>
                          {tab.cols.map((c) => <th key={c.key} className="num">{c.label}</th>)}
                          <th className="num">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tab.rows.map((r) => (
                          <tr key={r.key}>
                            <td>{label(r.key, r.label)}</td>
                            {tab.cols.map((c) => {
                              const cell = tab.cells[r.key]?.[c.key];
                              return <td key={c.key} className="num" title={cell ? (hide ? undefined : `realised ${inr(cell.realized)}, charges ${inr(cell.charges)}`) : undefined}>{cell ? signed(cell.net, 0) : <span className="muted">—</span>}</td>;
                            })}
                            <td className="num"><b>{signed(tab.cols.reduce((a, c) => a + (tab.cells[r.key]?.[c.key]?.net ?? 0), 0), 0)}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="muted">Net after charges, in rupees.</p>
                  </div>
                );
              })()}
              {cut === "charges" &&
                (s.chargesByGroup.some((c) => c.amount !== 0) ? (
                  <div className="fam-scroll">
                    <table className="fam-table">
                      <tbody>
                        {s.chargesByGroup.filter((c) => c.amount !== 0).map((c) => (
                          <tr key={c.group}>
                            <td>{c.group}</td>
                            <td className="num">{money(c.amount)}</td>
                            <td className="num muted">{hide || s.totals.charges === 0 ? "" : `${((c.amount / s.totals.charges) * 100).toFixed(1)}%`}</td>
                            <td className="fam-barcol"><Bar value={-c.amount} max={Math.max(...s.chargesByGroup.map((x) => x.amount))} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">No charges recorded.</p>
                ))}
            </section>

            {data.statementPeriods.length > 0 && (
              <section className="fam-card no-drag">
                <h2>Statement for your accountant</h2>
                <p className="muted">One member's year: per segment the realised result, the charges by head and the net, then every contract. Prepared from the statements as reported, not tax advice.</p>
                <div className="fam-add">
                  <label>
                    Member
                    <Select value={stMemberId} onChange={(e) => setStMember(e.target.value)}>
                      {data.members.filter((m) => data.accounts.some((a) => a.memberId === m.id)).map((m) => (
                        <option key={m.id} value={m.id}>{memberName(m.id)}</option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    Year
                    <Select value={stPeriod} onChange={(e) => setStYear(e.target.value)}>
                      {data.statementPeriods.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </Select>
                  </label>
                  <Button size="sm" disabled={busy || hide || !stMemberId} onClick={() => void statement("page")} title={hide ? "Turn off Hide names and amounts first" : "Open a printable page (print it or save it as PDF)"}>Open printable page</Button>
                  <Button size="sm" disabled={busy || hide || !stMemberId} onClick={() => void statement("csv")} title={hide ? "Turn off Hide names and amounts first" : "Download as CSV"}>Download CSV</Button>
                </div>
              </section>
            )}
          </>
        ))}

      {active === "contracts" && (
        <section className="fam-card no-drag">
          {contractsError ? (
            <p className="down" role="alert">{contractsError}</p>
          ) : !contractsData || contractsData.query !== query ? (
            <p className="muted" role="status">Loading contracts…</p>
          ) : contractsData.rows.length === 0 ? (
            <p className="muted">No contracts in this selection.</p>
          ) : (
            <>
              <div className="fam-cuts">
                <Input className="fam-search" type="search" placeholder="Search contract or underlying" aria-label="Search contracts" value={q} onChange={(e) => { setQ(e.target.value); setShown(FIRST_ROWS); }} />
                <span className="muted">{contractList.length} of {contractsData.total} contracts</span>
                <Button size="sm" onClick={downloadContracts} disabled={hide} title={hide ? "Turn off Hide names and amounts to export" : "Download the contracts on screen as CSV"}>Download CSV</Button>
              </div>
              <div className="fam-scroll">
                <table className="fam-table fam-contracts">
                  <thead>
                    <tr>
                      {sortHead("symbol", "Contract")}
                      {sortHead("segment", "Segment")}
                      {sortHead("member", "Member")}
                      {sortHead("fy", "Year")}
                      {sortHead("quantity", "Qty", true)}
                      {sortHead("realized", "Realised", true)}
                      {sortHead("charges", "Charges", true)}
                      {sortHead("net", "Net", true)}
                    </tr>
                  </thead>
                  <tbody>
                    {contractList.slice(0, shown).map((c) => (
                      <ContractLine key={c.id} c={c} member={memberName(c.memberId)} hide={hide} />
                    ))}
                  </tbody>
                </table>
              </div>
              {contractList.length > shown && <Button size="sm" onClick={() => setShown((n) => n + MORE_ROWS)}>Show {Math.min(MORE_ROWS, contractList.length - shown)} more ({contractList.length - shown} not shown)</Button>}
              {contractsData.total > contractsData.rows.length && <p className="muted">Only the first {contractsData.rows.length} contracts are loaded; narrow the year, member or segment above to see the rest.</p>}
              <p className="muted">Charges and net appear only where the statement gives charges per contract (Kotak's). Zerodha's statement gives one total for the period.</p>
            </>
          )}
        </section>
      )}

      {active === "months" && (
        <>
          {monthly.months.length === 0 ? (
            <p className="muted">No month to show: no statement here has a tradebook, and its contract names carry no expiry month to place them by. Add a tradebook for the same period in <b>Files and people</b>.</p>
          ) : (
            <>
              <section className="fam-card">
                <h2>Day by day</h2>
                <CalendarHeat days={monthly.days} hide={hide} />
              </section>
              <div className="fam-scroll"><table className="fam-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num" title="From a tradebook's dated trades, first in first out">Exact</th>
                    <th className="num" title="Contracts of statements without dates, placed in the month they expire">Estimate</th>
                    <th className="num" title="Exact charges, plus the estimate's: the statement's total shared by traded value, or the contract's own charges where the statement gives them">Charges</th>
                    <th className="num">Net</th>
                    <th className="fam-barcol" />
                    <th className="num">Contracts</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const max = Math.max(1, ...monthly.months.map((m) => Math.abs(m.net)));
                    return monthly.months.map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td className="num">{m.closes > 0 ? signed(m.realized) : <span className="muted">—</span>}</td>
                        <td className="num">{m.est.contracts > 0 ? <i title="Placed by the month the contracts expire">{signed(m.est.realized)}</i> : <span className="muted">—</span>}</td>
                        <td className="num">{money(m.charges + m.est.charges)}</td>
                        <td className="num">{signed(m.net)}</td>
                        <td><Bar value={m.net} max={max} /></td>
                        <td className="num muted">{m.closes + m.est.contracts}</td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table></div>
              <p className="muted">
                <b>Exact</b> comes from a tradebook's dated trades. <b>Estimate</b> places each contract of a statement without dates in the month it expires: right for short-dated options, up to a few weeks late for contracts held longer, and never later than the statement or its import. The months add up to the totals.
                {monthly.unplaced.contracts > 0 && ` ${monthly.unplaced.contracts} contract${monthly.unplaced.contracts === 1 ? "" : "s"} carry no expiry in their name and are in no month${hide ? "" : ` (${inr(monthly.unplaced.realized)})`}.`}
              </p>
            </>
          )}
          {monthly.reconciliation.filter((r) => r.ok).length > 0 && <p className="up">✓ {monthly.reconciliation.filter((r) => r.ok).length} statement{monthly.reconciliation.filter((r) => r.ok).length === 1 ? "" : "s"} add{monthly.reconciliation.filter((r) => r.ok).length === 1 ? "s" : ""} up to the tradebook, symbol by symbol.</p>}
        </>
      )}

      {active === "setup" && (
        <>
          <h2>Add files</h2>
          <p className="muted">
            <b>Zerodha Console:</b> Reports → P&amp;L and Reports → Tradebook, as Excel. <b>Kotak Neo:</b> Profile → Reports → Gain &amp; Loss Statement (the totals and charges) and Transaction Statement (every trade with its date), as Excel. Each file finds its account by client id; a statement gives the totals and charges, a tradebook or Transaction Statement gives the months.
          </p>
          <div
            className={`fam-drop no-drag${dragging ? " over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!busy) void upload(e.dataTransfer.files);
            }}
          >
            <p role="status">{busy ? (progress ?? "Reading…") : "Drop Excel files here, or"}</p>
            <input ref={input} type="file" accept=".xlsx" multiple disabled={busy} onChange={(e) => void upload(e.target.files)} aria-label="Choose statement or tradebook files" />
          </div>
          {outcomes.map((o) => (
            <p key={o.file} className={o.skipped ? "muted" : o.ok ? "up" : "down"}>
              {o.skipped ? "•" : o.ok ? "✓" : "✗"} {hide ? "file" : o.file}: {o.text}
              {o.canAccept && (
                <Button size="sm" disabled={busy} onClick={() => void upload(null, true, o)}>Import anyway</Button>
              )}
            </p>
          ))}

          <h2>People and accounts</h2>
          <table className="fam-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Account</th>
                <th>Client id</th>
                <th className="num">Files</th>
                <th>Move to</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => {
                const m = data.members.find((x) => x.id === a.memberId);
                return (
                  <tr key={a.id}>
                    <td>
                      {hide ? (
                        memberName(a.memberId)
                      ) : (
                        <Input
                          defaultValue={m?.nickname}
                          key={`${m?.id}-${m?.nickname}`}
                          aria-label={`Name of member ${a.memberId}`}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (m && v && v !== m.nickname) void act(() => patch(`/members/${m.id}`, { nickname: v }));
                          }}
                        />
                      )}
                    </td>
                    <td>
                      {hide ? `account ${a.id}` : a.label} <span className="muted">· {BROKER_LABELS[a.broker]}</span>
                    </td>
                    <td>
                      {a.clientCode ? (
                        <Button size="sm"
                          onClick={() =>
                            setReveal((r) => {
                              const n = new Set(r);
                              if (n.has(a.id)) n.delete(a.id);
                              else n.add(a.id);
                              return n;
                            })
                          }
                          title="Show or hide the client id"
                        >
                          {hide || !reveal.has(a.id) ? maskCode(a.clientCode) : a.clientCode}
                        </Button>
                      ) : (
                        <span className="muted">not set</span>
                      )}
                    </td>
                    <td className="num muted">{data.imports.filter((i) => i.accountId === a.id).length}</td>
                    <td>
                      <Select value="" disabled={busy || hide} aria-label={`Move account ${a.id} to another member`} onChange={(e) => e.target.value && void act(() => patch(`/accounts/${a.id}`, { memberId: Number(e.target.value) }))}>
                        <option value="">…</option>
                        {data.members.filter((x) => x.id !== a.memberId).map((x) => (
                          <option key={x.id} value={x.id}>{x.nickname}</option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                );
              })}
              {data.accounts.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">Nobody yet: add a file above and its account appears here.</td>
                </tr>
              )}
            </tbody>
          </table>
          {!hide && (
            <form
              className="no-drag fam-add"
              onSubmit={(e) => {
                e.preventDefault();
                const v = newMember.trim();
                if (v)
                  void act(async () => {
                    await post("/members", { nickname: v });
                    setNewMember("");
                  });
              }}
            >
              <Input value={newMember} onChange={(e) => setNewMember(e.target.value)} placeholder="New member's name" aria-label="New member's name" />
              <Button size="sm" disabled={busy || !newMember.trim()}>Add member</Button>
              {data.members.filter((m) => !data.accounts.some((a) => a.memberId === m.id)).map((m) => (
                <button key={m.id} type="button" className="tf" title="Remove a member who has no accounts" onClick={() => void act(() => call(`/members/${m.id}`, { method: "DELETE" }))}>Remove {m.nickname}</button>
              ))}
            </form>
          )}

          {data.coverage.years.length > 0 && (
            <>
              <h2>What is loaded</h2>
              <div className="fam-scroll">
                <table className="fam-table fam-cover">
                  <thead>
                    <tr>
                      <th>Account</th>
                      {data.coverage.years.map((y) => <th key={y} className="num">{y}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {data.coverage.rows.map((r) => {
                      const a = data.accounts.find((x) => x.id === r.accountId);
                      return (
                        <tr key={r.accountId}>
                          <td>{a ? accountName(a) : r.accountId}</td>
                          {data.coverage.years.map((y) => {
                            const c = r.cells[y];
                            if (!c) return <td key={y} className="num"><span className="muted" title="Nothing loaded for this year">—</span></td>;
                            return (
                              <td key={y} className="num" title={`${c.statements.map((sg) => SEGMENT_LABELS[sg]).join(", ") || "no statement"}${c.tradebook ? "; tradebook loaded" : "; no tradebook"}${c.partial ? "; covers only part of the year" : ""}`}>
                                {c.statements.length > 0 ? <span className={c.partial ? "fam-part" : "fam-ok"}>✓ {c.statements.map((sg) => (sg === "commodity" ? "Com" : sg === "fno" ? "F&O" : SEGMENT_LABELS[sg])).join(" + ")}</span> : <span className="muted">no statement</span>}
                                {c.tradebook && <span className="fam-ok"> · months</span>}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted">✓ a statement is loaded (amber: it covers only part of the year). “months” means a tradebook is loaded too, which is what gives the month-by-month view.</p>
            </>
          )}

          {data.imports.length > 0 && (
            <>
              <h2>Files read</h2>
              <table className="fam-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Kind</th>
                    <th>Period</th>
                    <th className="num">Rows</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.imports.map((i) => (
                    <tr key={i.id}>
                      <td>{hide ? `file ${i.id}` : i.fileName}</td>
                      <td>{i.kind === "pnl" ? "Statement" : "Tradebook"} · {SEGMENT_LABELS[i.segment]}</td>
                      <td>{i.periodFrom} to {i.periodTo}</td>
                      <td className="num muted">{i.rows}{i.problems.length ? ` · ${i.problems.length} problem${i.problems.length === 1 ? "" : "s"}` : ""}</td>
                      <td>
                        <Button size="sm"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm("Remove this import? Its numbers leave every total. The file itself is not kept, so upload it again to bring it back.")) void act(() => call(`/imports/${i.id}`, { method: "DELETE" }));
                          }}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
