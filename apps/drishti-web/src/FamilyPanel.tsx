import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BROKER_LABELS, familyCsv, maskCode, SEGMENT_LABELS, statementHtml, statementRows, toCsv, type AccountantStatement, type ContractRow, type CoverageView, type CrossTab, type FamilyAccount, type FamilyMember, type GroupRow, type Insights, type MonthlyView, type Segment, type Summary } from "@drishti/shared";
import { apiUrl } from "./settings";
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
  contracts: ContractRow[];
  contractsTotal: number;
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
const inr = (n: number, dp = 2) => n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl()}/family${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(typeof body?.message === "string" ? body.message : `HTTP ${res.status}`), { status: res.status });
  return body as T;
}
const post = <T,>(path: string, body: unknown) => call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) => call<T>(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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

/** The net of each month as bars, with the running total as a line. Values are left out of the picture while amounts are hidden. */
function MonthChart({ months, hide }: { months: { month: string; net: number }[]; hide: boolean }) {
  const n = months.length;
  const step = 44;
  const W = Math.max(320, n * step);
  const H = 180;
  const top = 12;
  const bottom = 24;
  const mid = top + (H - top - bottom) / 2;
  let run = 0;
  const cum = months.map((m) => (run += m.net));
  const maxAbs = Math.max(1, ...months.map((m) => Math.abs(m.net)), ...cum.map(Math.abs));
  const k = (mid - top) / maxAbs;
  const x = (i: number) => (W / n) * (i + 0.5);
  const bw = Math.min(26, (W / n) * 0.6);
  return (
    <svg className="fam-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={hide ? "Net by month (values hidden)" : `Net by month, ${n} months`}>
      <line x1="0" x2={W} y1={mid} y2={mid} className="fam-zero" />
      {months.map((m, i) => (
        <g key={m.month}>
          <rect x={x(i) - bw / 2} y={m.net >= 0 ? mid - m.net * k : mid} width={bw} height={Math.max(1, Math.abs(m.net) * k)} className={m.net >= 0 ? "fam-up" : "fam-down"} rx="2">
            {!hide && <title>{`${m.month}: ${inr(m.net)}`}</title>}
          </rect>
          <text x={x(i)} y={H - 8} textAnchor="middle" className="fam-axis">{monthLabel(m.month)}</text>
        </g>
      ))}
      {n > 1 && <polyline className="fam-cum" fill="none" points={cum.map((c, i) => `${x(i)},${mid - c * k}`).join(" ")} />}
      {n > 1 && cum.map((c, i) => <circle key={i} cx={x(i)} cy={mid - c * k} r="2.5" className="fam-cumdot">{!hide && <title>{`running total ${inr(c)}`}</title>}</circle>)}
    </svg>
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
  const [period, setPeriod] = useState("");
  const [memberId, setMemberId] = useState("");
  const [segment, setSegment] = useState("");
  const [reveal, setReveal] = useState<Set<number>>(new Set());
  const [newMember, setNewMember] = useState("");
  const [tab, setTab] = useState<Tab | null>(null);
  const [cut, setCut] = useState<Cut>("account");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "realized", dir: 1 });
  const [shown, setShown] = useState(200);
  const [stMember, setStMember] = useState("");
  const [stYear, setStYear] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (period) q.set("period", period);
    if (memberId) q.set("member", memberId);
    if (segment) q.set("segment", segment);
    const s = q.toString();
    return s ? `?${s}` : "";
  }, [period, memberId, segment]);

  const reload = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([call<Overview>(""), call<Report>(`/summary${query}`)]);
      // an API that has not been restarted since an update answers without the newer fields: the screen shows what it has instead of failing
      setData({ ...o, coverage: o.coverage ?? { years: [], rows: [] }, statementPeriods: o.statementPeriods ?? [] });
      setReport({ ...r, contracts: r.contracts ?? [], contractsTotal: r.contractsTotal ?? 0, insights: r.insights ?? null, yearBySegment: r.yearBySegment ?? { rows: [], cols: [], cells: {} }, memberByYear: r.memberByYear ?? { rows: [], cols: [], cells: {} } });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query]);
  useEffect(() => {
    void reload();
  }, [reload]);

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

  const upload = async (files: FileList | null, accept = false, again?: Outcome) => {
    const list = again ? [{ name: again.file, buf: again.bytes! }] : await Promise.all([...(files ?? [])].map(async (f) => ({ name: f.name, buf: await f.arrayBuffer() })));
    if (!list.length) return;
    setBusy(true);
    const out: Outcome[] = [];
    for (const f of list) {
      try {
        const r = await call<{ kind: string; segment: Segment; segments?: Segment[]; periodFrom: string; periodTo: string; rows: number; newAccount: boolean; client: string; filedUnder?: string }>(`/import?name=${encodeURIComponent(f.name)}${accept ? "&accept=1" : ""}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f.buf });
        out.push({ file: f.name, ok: true, text: `${r.kind === "pnl" ? "Statement" : "Tradebook"} ${(r.segments ?? [r.segment]).map((x) => SEGMENT_LABELS[x]).join(" + ")} ${r.periodFrom} to ${r.periodTo}: ${r.rows} ${r.kind === "pnl" ? "symbols" : "fills"} read${r.newAccount ? (r.filedUnder ? `, new account for client ${r.client}, filed under ${hide ? "the member of that name" : r.filedUnder}` : `, new account for client ${r.client} (name the person below)`) : ""}` });
      } catch (e) {
        const msg = (e as Error).message;
        const skipped = /exact file is already imported/.test(msg);
        out.push({ file: f.name, ok: false, ...(skipped ? { skipped: true } : {}), text: skipped ? "already imported, skipped (nothing was counted twice). Remove it from the list below to import it again." : msg, canAccept: /does not add up/.test(msg), bytes: f.buf });
      }
    }
    setOutcomes((prev) => [...out, ...prev.filter((p) => !out.some((o) => o.file === p.file))].slice(0, 12));
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
  const brokerOf = (importId: number) => data.accounts.find((a) => a.id === data.imports.find((i) => i.id === importId)?.accountId)?.broker;
  const kotakOnly = monthly.withoutTradebook.filter((w) => brokerOf(w.importId) === "kotak");
  const zerodhaMissing = monthly.withoutTradebook.filter((w) => brokerOf(w.importId) !== "kotak");
  if (zerodhaMissing.length > 0)
    alerts.push({ key: "notb", tone: "info", title: "Months are missing", text: `No tradebook yet for ${[...new Set(zerodhaMissing.map((w) => (hide ? "a statement" : `${w.periodFrom} to ${w.periodTo}`)))].join(", ")}: the statement gives the totals but only a tradebook gives the months.` });
  if (kotakOnly.length > 0)
    alerts.push({ key: "kotak-months", tone: "info", title: "No months for Kotak", text: `Kotak's Gain & Loss report has no trade dates${hide ? "" : ` (${[...new Set(kotakOnly.map((w) => `${w.periodFrom} to ${w.periodTo}`))].join(", ")})`}, so it gives the year's totals and charges but no months. Months would need Kotak's contract notes, which are not read yet.` });
  const alertCard = (a: (typeof alerts)[number]) => (
    <div key={a.key} className={`fam-alert ${a.tone}`} role={a.tone === "warn" ? "alert" : "status"}>
      <div>
        <b>{a.title}</b>
        <p>{a.text}</p>
      </div>
      {a.key !== "kotak-months" && <button className="tf" onClick={() => setTab("setup")}>{a.key === "unassigned" ? "Name them" : "Add files"}</button>}
    </div>
  );
  // one thing to check is shown as it is; several fold into one line that opens, so the numbers stay at the top
  const alertBlock =
    alerts.length === 0 ? null : alerts.length === 1 ? (
      <div className="fam-alerts no-drag">{alertCard(alerts[0])}</div>
    ) : (
      <details className="fam-alerts no-drag">
        <summary>
          {alerts.some((a) => a.tone === "warn") && <span className="fam-dot" aria-hidden="true" />}
          <b>{alerts.length} things to check</b>
          <small>{alerts.map((a) => a.title).join(" · ")}</small>
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

  // ---- every contract: searched, sorted, and saved as CSV
  const contractList = (() => {
    const needle = q.trim().toLowerCase();
    const mname = (id: number) => (data.members.find((m) => m.id === id)?.nickname ?? "").toLowerCase();
    const list = report.contracts.filter((c) => !needle || c.symbol.toLowerCase().includes(needle) || c.underlying.toLowerCase().includes(needle) || (!hide && mname(c.memberId).includes(needle)));
    const val = (c: ContractRow): number | string => (sort.key === "member" ? mname(c.memberId) : sort.key === "segment" ? c.segment : sort.key === "symbol" ? c.symbol : sort.key === "fy" ? c.fy : (c[sort.key] ?? Number.POSITIVE_INFINITY));
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  })();
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

  const tabButton = (id: Tab, text: string) => (
    <button key={id} className={`tf${active === id ? " active" : ""}`} aria-pressed={active === id} onClick={() => setTab(id)}>{text}</button>
  );

  return (
    <div className="family">
      <div className="fam-top no-drag">
        <span className="fam-tabs">
          {tabButton("overview", "Overview")}
          {tabButton("contracts", "Contracts")}
          {tabButton("months", "Months")}
          {tabButton("setup", "Files and people")}
        </span>
        <label>
          Year
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">All years</option>
            {s.byPeriod.map((p) => (
              <option key={p.key} value={p.key}>{p.key}</option>
            ))}
          </select>
        </label>
        <label>
          Member
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">Everyone</option>
            {data.members.map((m) => (
              <option key={m.id} value={m.id}>{memberName(m.id)}</option>
            ))}
          </select>
        </label>
        <label>
          Segment
          <select value={segment} onChange={(e) => setSegment(e.target.value)}>
            <option value="">All</option>
            {(Object.keys(SEGMENT_LABELS) as Segment[]).map((k) => (
              <option key={k} value={k}>{SEGMENT_LABELS[k]}</option>
            ))}
          </select>
        </label>
        {hasData && (
          <button className="tf" onClick={download} disabled={hide} title={hide ? "Turn off Hide names and amounts to export (the file carries names and amounts)" : "Download what is on screen as a CSV file"}>
            Download CSV
          </button>
        )}
        <label className="fam-hide" title="Hides names and amounts on screen. It is not encryption.">
          <input type="checkbox" checked={hide} onChange={toggleHide} /> Hide names and amounts
        </label>
      </div>
      {error && <p className="down" role="alert">{error}</p>}
      {active !== "setup" && alertBlock}

      {active === "overview" &&
        (!hasData ? (
          <p className="muted">No statement yet, so there is nothing to total. Add a Zerodha P&amp;L file in <b>Files and people</b>. A tradebook alone gives the months but not the charges.</p>
        ) : (
          <>
            <div className="fam-kpis">
              <div className="fam-kpi">
                <span>Realised P&amp;L</span>
                <b>{signed(s.totals.realized)}</b>
                <small>{hide ? "••" : `${s.totals.winners} winning, ${s.totals.losers} losing symbols`}</small>
              </div>
              <div className="fam-kpi">
                <span>Charges and taxes</span>
                <b>{money(s.totals.charges)}</b>
                <small>{hide ? "••" : s.totals.profits > 0 ? `${((s.totals.charges / s.totals.profits) * 100).toFixed(1)}% of the winnings` : "no winnings to compare"}</small>
              </div>
              <div className={`fam-kpi net ${s.totals.net > 0 ? "up" : s.totals.net < 0 ? "down" : ""}`}>
                <span>Net after charges</span>
                <b>{money(s.totals.net)}</b>
                <small>
                  {hide
                    ? "••"
                    : s.byPeriod.length > 1
                      ? (() => {
                          const best = [...s.byPeriod].sort((x, y) => y.net - x.net);
                          return `best ${best[0].label} ${inr(best[0].net, 0)}, worst ${best[best.length - 1].label} ${inr(best[best.length - 1].net, 0)}`;
                        })()
                      : "after brokerage, taxes and fees"}
                </small>
              </div>
            </div>
            <p className="fam-meta">
              <span title="Open positions as the broker marked them at the end of the statement; not part of the net">Unrealised (reported) {signed(s.totals.unrealized)}</span>
              <span title="The sum of each symbol's absolute net result. The true turnover uses every trade, so this is a lower bound; ask your accountant for the filing figure.">F&amp;O turnover, at least {money(s.totals.turnoverAtLeast, 0)}</span>
              <span>{s.totals.symbols} symbols traded</span>
            </p>

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

            <section className="fam-card">{rowsTable("Financial year", s.byPeriod, (r) => r.label)}</section>

            <section className="fam-card">
              <div className="fam-cuts no-drag" role="tablist" aria-label="Break the numbers down by">
                <span className="muted">Break down by</span>
                {(["account", "segment", "underlying", "charges", "yearseg", "memberyear"] as Cut[]).map((c) => (
                  <button key={c} role="tab" aria-selected={cut === c} className={`tf${cut === c ? " active" : ""}`} onClick={() => setCut(c)}>
                    {c === "charges" ? "Charges and taxes" : c === "yearseg" ? "Year × segment" : c === "memberyear" ? "Member × year" : c[0].toUpperCase() + c.slice(1)}
                  </button>
                ))}
              </div>
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
                    <select value={stMemberId} onChange={(e) => setStMember(e.target.value)}>
                      {data.members.filter((m) => data.accounts.some((a) => a.memberId === m.id)).map((m) => (
                        <option key={m.id} value={m.id}>{memberName(m.id)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Year
                    <select value={stPeriod} onChange={(e) => setStYear(e.target.value)}>
                      {data.statementPeriods.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  </label>
                  <button className="tf" disabled={busy || hide || !stMemberId} onClick={() => void statement("page")} title={hide ? "Turn off Hide names and amounts first" : "Open a printable page (print it or save it as PDF)"}>Open printable page</button>
                  <button className="tf" disabled={busy || hide || !stMemberId} onClick={() => void statement("csv")} title={hide ? "Turn off Hide names and amounts first" : "Download as CSV"}>Download CSV</button>
                </div>
              </section>
            )}
          </>
        ))}

      {active === "contracts" && (
        <section className="fam-card no-drag">
          {report.contracts.length === 0 ? (
            <p className="muted">No contracts in this selection.</p>
          ) : (
            <>
              <div className="fam-cuts">
                <input className="fam-search" type="search" placeholder="Search contract or underlying" aria-label="Search contracts" value={q} onChange={(e) => { setQ(e.target.value); setShown(200); }} />
                <span className="muted">{contractList.length} of {report.contractsTotal} contracts</span>
                <button className="tf" onClick={downloadContracts} disabled={hide} title={hide ? "Turn off Hide names and amounts to export" : "Download the contracts on screen as CSV"}>Download CSV</button>
              </div>
              <div className="fam-scroll">
                <table className="fam-table">
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
                      <tr key={c.id}>
                        <td title={c.file}>{c.symbol}</td>
                        <td>{SEGMENT_LABELS[c.segment]}</td>
                        <td>{memberName(c.memberId)}</td>
                        <td>{c.fy}</td>
                        <td className="num">{c.quantity}</td>
                        <td className="num">{signed(c.realized)}</td>
                        <td className="num">{c.charges === undefined ? <span className="muted" title="This statement gives charges for the whole period, not per contract">—</span> : money(c.charges)}</td>
                        <td className="num">{c.net === undefined ? <span className="muted">—</span> : signed(c.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {contractList.length > shown && <button className="tf" onClick={() => setShown((n) => n + 300)}>Show {Math.min(300, contractList.length - shown)} more</button>}
              {report.contractsTotal > report.contracts.length && <p className="muted">Only the first {report.contracts.length} contracts are loaded; narrow the year, member or segment above to see the rest.</p>}
              <p className="muted">Charges and net appear only where the statement gives charges per contract (Kotak's). Zerodha's statement gives one total for the period.</p>
            </>
          )}
        </section>
      )}

      {active === "months" && (
        <>
          {monthly.months.length === 0 ? (
            <p className="muted">Months need a tradebook (the statement has no dates). Download it from Console → Reports → Tradebook for the same period and add it in <b>Files and people</b>.</p>
          ) : (
            <>
              <section className="fam-card">
                <MonthChart months={monthly.months} hide={hide} />
                <p className="fam-legend"><i className="fam-up" /> month <i className="fam-line" /> running total</p>
              </section>
              <div className="fam-scroll"><table className="fam-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Realised</th>
                    <th className="num" title="The statement's charges spread over the months by traded value: an estimate">Charges (est.)</th>
                    <th className="num">Net</th>
                    <th className="fam-barcol" />
                    <th className="num">Closes</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const max = Math.max(...monthly.months.map((m) => Math.abs(m.net)));
                    return monthly.months.map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td className="num">{signed(m.realized)}</td>
                        <td className="num">{money(m.charges)}</td>
                        <td className="num">{signed(m.net)}</td>
                        <td><Bar value={m.net} max={max} /></td>
                        <td className="num muted">{m.closes}</td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table></div>
              <p className="muted">Realised is exact, from the dated trades (first in, first out). Charges are the statement's total spread over the months by traded value: an estimate by month, exact in total.</p>
            </>
          )}
          {monthly.reconciliation.filter((r) => r.ok).length > 0 && <p className="up">✓ {monthly.reconciliation.filter((r) => r.ok).length} statement{monthly.reconciliation.filter((r) => r.ok).length === 1 ? "" : "s"} add{monthly.reconciliation.filter((r) => r.ok).length === 1 ? "s" : ""} up to the tradebook, symbol by symbol.</p>}
        </>
      )}

      {active === "setup" && (
        <>
          <h2>Add files</h2>
          <p className="muted">
            <b>Zerodha Console:</b> Reports → P&amp;L and Reports → Tradebook, as Excel. <b>Kotak Neo:</b> Profile → Reports → Gain &amp; Loss Statement, as Excel. Each file finds its account by client id; a statement gives the totals and charges, a Zerodha tradebook gives the months.
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
            <p>{busy ? "Reading…" : "Drop Excel files here, or"}</p>
            <input ref={input} type="file" accept=".xlsx" multiple disabled={busy} onChange={(e) => void upload(e.target.files)} aria-label="Choose statement or tradebook files" />
          </div>
          {outcomes.map((o) => (
            <p key={o.file} className={o.skipped ? "muted" : o.ok ? "up" : "down"}>
              {o.skipped ? "•" : o.ok ? "✓" : "✗"} {hide ? "file" : o.file}: {o.text}
              {o.canAccept && (
                <button className="tf" disabled={busy} onClick={() => void upload(null, true, o)}>Import anyway</button>
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
                        <input
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
                        <button
                          className="tf"
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
                        </button>
                      ) : (
                        <span className="muted">not set</span>
                      )}
                    </td>
                    <td className="num muted">{data.imports.filter((i) => i.accountId === a.id).length}</td>
                    <td>
                      <select value="" disabled={busy || hide} aria-label={`Move account ${a.id} to another member`} onChange={(e) => e.target.value && void act(() => patch(`/accounts/${a.id}`, { memberId: Number(e.target.value) }))}>
                        <option value="">…</option>
                        {data.members.filter((x) => x.id !== a.memberId).map((x) => (
                          <option key={x.id} value={x.id}>{x.nickname}</option>
                        ))}
                      </select>
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
              <input value={newMember} onChange={(e) => setNewMember(e.target.value)} placeholder="New member's name" aria-label="New member's name" />
              <button className="tf" disabled={busy || !newMember.trim()}>Add member</button>
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
                        <button
                          className="tf"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm("Remove this import? Its numbers leave every total. The file itself is not kept, so upload it again to bring it back.")) void act(() => call(`/imports/${i.id}`, { method: "DELETE" }));
                          }}
                        >
                          Remove
                        </button>
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
