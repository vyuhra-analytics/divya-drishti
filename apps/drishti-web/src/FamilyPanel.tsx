import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BROKER_LABELS, maskCode, SEGMENT_LABELS, type FamilyAccount, type FamilyMember, type GroupRow, type MonthlyView, type Segment, type Summary } from "@drishti/shared";
import { apiUrl } from "./settings";
import type { Widget } from "./workspace";

// The household's broker statements: upload a Zerodha Console P&L or tradebook and the file finds its account by client id (a new one is created under an
// "Unassigned" member when none exists, to be renamed or moved to the right person later), then read realised P&L, charges and the net by financial year,
// member, account, segment, underlying and month. A record-keeper: nothing here places an order. The hide switch masks names and amounts on screen.

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
}
interface Report {
  summary: Summary;
  monthly: MonthlyView;
}
interface Outcome {
  file: string;
  ok: boolean;
  text: string;
  canAccept?: boolean;
  bytes?: ArrayBuffer;
}

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
      setData(o);
      setReport(r);
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
  const signed = (n: number, dp = 0) => <span className={n > 0 ? "up" : n < 0 ? "down" : ""}>{money(n, dp)}</span>;

  const upload = async (files: FileList | null, accept = false, again?: Outcome) => {
    const list = again ? [{ name: again.file, buf: again.bytes! }] : await Promise.all([...(files ?? [])].map(async (f) => ({ name: f.name, buf: await f.arrayBuffer() })));
    if (!list.length) return;
    setBusy(true);
    const out: Outcome[] = [];
    for (const f of list) {
      try {
        const r = await call<{ kind: string; segment: Segment; periodFrom: string; periodTo: string; rows: number; newAccount: boolean; client: string }>(`/import?name=${encodeURIComponent(f.name)}${accept ? "&accept=1" : ""}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f.buf });
        out.push({ file: f.name, ok: true, text: `${r.kind === "pnl" ? "Statement" : "Tradebook"} ${SEGMENT_LABELS[r.segment]} ${r.periodFrom} to ${r.periodTo}: ${r.rows} ${r.kind === "pnl" ? "symbols" : "fills"} read${r.newAccount ? `, new account for client ${r.client} (name the person below)` : ""}` });
      } catch (e) {
        const msg = (e as Error).message;
        out.push({ file: f.name, ok: false, text: msg, canAccept: /does not add up/.test(msg), bytes: f.buf });
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
  const periodChoices = s.byPeriod;
  const rowsTable = (title: string, rows: GroupRow[], label: (r: GroupRow) => string) =>
    rows.length === 0 ? null : (
      <>
        <h2>{title}</h2>
        <table>
          <thead>
            <tr>
              <th>{title.replace(/^By /, "")}</th>
              <th>Realised</th>
              <th>Charges</th>
              <th>Net</th>
              <th title="winning and losing symbols">W / L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{label(r)}</td>
                <td>{signed(r.realized)}</td>
                <td>{money(r.charges)}</td>
                <td>{signed(r.net)}</td>
                <td className="muted">{r.winners} / {r.losers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );

  return (
    <div className="family">
      <div className="costs-form no-drag">
        <label title="Hides names and amounts on screen. It is not encryption.">
          <input type="checkbox" checked={hide} onChange={toggleHide} /> Hide names and amounts
        </label>
        <label>
          Year
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">All years</option>
            {periodChoices.map((p) => (
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
      </div>
      {error && <p className="down" role="alert">{error}</p>}

      <h2>Add files</h2>
      <p className="muted">
        Zerodha Console: <b>Reports → P&amp;L</b> and <b>Reports → Tradebook</b>, downloaded as Excel. Each file finds its account by client id; the statement gives the totals and charges, the tradebook gives the months.
      </p>
      <input ref={input} type="file" accept=".xlsx" multiple disabled={busy} onChange={(e) => void upload(e.target.files)} aria-label="Choose statement or tradebook files" />
      {outcomes.map((o) => (
        <p key={o.file} className={o.ok ? "up" : "down"}>
          {o.ok ? "✓" : "✗"} {hide ? "file" : o.file}: {o.text}
          {o.canAccept && (
            <button className="tf" disabled={busy} onClick={() => void upload(null, true, o)}>Import anyway</button>
          )}
        </p>
      ))}

      <h2>People and accounts</h2>
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Account</th>
            <th>Client id</th>
            <th>Files</th>
            <th>Move to</th>
          </tr>
        </thead>
        <tbody>
          {data.accounts.map((a) => {
            const m = data.members.find((x) => x.id === a.memberId);
            return (
              <tr key={a.id}>
                <td>
                  {hide ? memberName(a.memberId) : (
                    <input defaultValue={m?.nickname} aria-label={`Name of member ${a.memberId}`} onBlur={(e) => { const v = e.target.value.trim(); if (m && v && v !== m.nickname) void act(() => patch(`/members/${m.id}`, { nickname: v })); }} />
                  )}
                </td>
                <td>{hide ? `account ${a.id}` : a.label} <span className="muted">{BROKER_LABELS[a.broker]}</span></td>
                <td>
                  {a.clientCode ? (
                    <button className="tf" onClick={() => setReveal((r) => { const n = new Set(r); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} title="Show or hide the client id">
                      {hide || !reveal.has(a.id) ? maskCode(a.clientCode) : a.clientCode}
                    </button>
                  ) : <span className="muted">not set</span>}
                </td>
                <td className="muted">{data.imports.filter((i) => i.accountId === a.id).length}</td>
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
            <tr><td colSpan={5} className="muted">Nobody yet: add a file above and its account appears here.</td></tr>
          )}
        </tbody>
      </table>
      {!hide && (
        <form className="no-drag" onSubmit={(e) => { e.preventDefault(); const v = newMember.trim(); if (v) void act(async () => { await post("/members", { nickname: v }); setNewMember(""); }); }}>
          <input value={newMember} onChange={(e) => setNewMember(e.target.value)} placeholder="New member's name" aria-label="New member's name" />
          <button className="tf" disabled={busy || !newMember.trim()}>Add member</button>
          {data.members.filter((m) => !data.accounts.some((a) => a.memberId === m.id)).map((m) => (
            <button key={m.id} type="button" className="tf" title="Remove a member who has no accounts" onClick={() => void act(() => call(`/members/${m.id}`, { method: "DELETE" }))}>Remove {m.nickname}</button>
          ))}
        </form>
      )}

      {s.imports.length === 0 ? (
        <p className="muted">No statement yet, so there is nothing to total. A tradebook alone gives the months but not the charges.</p>
      ) : (
        <>
          <h2>Result</h2>
          <dl className="quote-grid">
            <div><dt>Realised P&amp;L</dt><dd>{signed(s.totals.realized)}</dd></div>
            <div><dt>Charges and taxes</dt><dd>{money(s.totals.charges)}</dd></div>
            <div><dt>Net after charges</dt><dd>{signed(s.totals.net)}</dd></div>
            <div><dt title="Open positions as the broker marked them at the end of the statement; not part of the net">Unrealised (reported)</dt><dd>{signed(s.totals.unrealized)}</dd></div>
            <div><dt title="The sum of each symbol's absolute net result. The true turnover uses every trade, so this is a lower bound; ask your accountant for the filing figure.">F&amp;O turnover (at least)</dt><dd>{money(s.totals.turnoverAtLeast, 0)}</dd></div>
            <div><dt>Charges as share of winnings</dt><dd>{hide ? "••" : s.totals.profits > 0 ? `${((s.totals.charges / s.totals.profits) * 100).toFixed(1)}%` : "—"}</dd></div>
          </dl>
          {rowsTable("By financial year", s.byPeriod, (r) => r.label)}
          {rowsTable("By member", s.byMember, (r) => memberName(Number(r.key)))}
          {rowsTable("By account", s.byAccount, (r) => { const a = data.accounts.find((x) => x.id === Number(r.key)); return a ? accountName(a) : r.label; })}
          {rowsTable("By segment", s.bySegment, (r) => SEGMENT_LABELS[r.key as Segment] ?? r.key)}
          {rowsTable("By underlying", s.byUnderlying, (r) => r.label)}
          {s.chargesByGroup.length > 0 && (
            <>
              <h2>Charges and taxes</h2>
              <table>
                <tbody>
                  {s.chargesByGroup.map((c) => (
                    <tr key={c.group}><td>{c.group}</td><td>{money(c.amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <h2>By month</h2>
      {monthly.months.length === 0 ? (
        <p className="muted">Months need a tradebook (the statement has no dates). Download it from Console → Reports → Tradebook for the same period.</p>
      ) : (
        <>
          <table>
            <thead>
              <tr><th>Month</th><th>Realised</th><th title="The statement's charges spread over the months by traded value: an estimate">Charges (estimated)</th><th>Net</th><th>Closes</th></tr>
            </thead>
            <tbody>
              {monthly.months.map((m) => (
                <tr key={m.month}><td>{m.month}</td><td>{signed(m.realized)}</td><td>{money(m.charges)}</td><td>{signed(m.net)}</td><td className="muted">{m.closes}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Realised is exact, from the dated trades (first in, first out). Charges are the statement's total spread over the months by traded value, so they are an estimate by month and exact in total.</p>
        </>
      )}
      {monthly.reconciliation.map((r) => (
        <p key={r.importId} className={r.ok ? "up" : "down"}>
          {r.ok ? "✓ The tradebook adds up to the statement, symbol by symbol." : `✗ The tradebook and the statement differ on ${r.differences.length} symbol${r.differences.length === 1 ? "" : "s"}: ${hide ? "hidden" : r.differences.map((d) => `${d.symbol} ${inr(d.difference)}`).join(", ")}. A position carried in from before the period or still open shows this way.`}
        </p>
      ))}
      {monthly.withoutTradebook.length > 0 && !hide && <p className="muted">No tradebook yet for {monthly.withoutTradebook.map((w) => `${w.periodFrom} to ${w.periodTo}`).join(", ")}.</p>}

      {data.imports.length > 0 && (
        <>
          <h2>Files read</h2>
          <table>
            <thead><tr><th>File</th><th>Kind</th><th>Period</th><th>Rows</th><th /></tr></thead>
            <tbody>
              {data.imports.map((i) => (
                <tr key={i.id}>
                  <td>{hide ? `file ${i.id}` : i.fileName}</td>
                  <td>{i.kind === "pnl" ? "Statement" : "Tradebook"} · {SEGMENT_LABELS[i.segment]}</td>
                  <td>{i.periodFrom} to {i.periodTo}</td>
                  <td className="muted">{i.rows}{i.problems.length ? ` · ${i.problems.length} problem${i.problems.length === 1 ? "" : "s"}` : ""}</td>
                  <td><button className="tf" disabled={busy} onClick={() => { if (window.confirm("Remove this import? Its numbers leave every total. The file itself is not kept, so upload it again to bring it back.")) void act(() => call(`/imports/${i.id}`, { method: "DELETE" })); }}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
