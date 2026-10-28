import { useEffect, useMemo, useRef, useState } from "react";
import { inReleaseWindow, type AnalysisLine, type EiaReportCode, type EiaReportRow, type ReportAnalysis } from "@drishti/shared";
import { apiUrl, useClock } from "./settings";
import { EiaArticleView } from "./EiaArticleView";
import { EiaForecastsView } from "./EiaForecastsView";
import type { Widget } from "./workspace";
import { Button, Input, Select } from "./ui";

interface Loaded {
  weekEnding: string;
  scheduledAt: number;
  officialReleaseAt?: number;
  firstStoredAt?: number;
  delayMs?: number;
  backfilled?: boolean;
  forecast?: { value: number; source?: string };
  rows: EiaReportRow[];
  analysis?: ReportAnalysis;
}

const POLL_FAST_MS = 3000;
const POLL_SLOW_MS = 60_000;

interface StoredWeek {
  weekEnding: string;
  officialReleaseAt?: number;
  backfilled: boolean;
}

const num = (n: number | undefined, dp = 1) => (n === undefined ? "" : n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const signed = (n: number | undefined, dp = 1) => (n === undefined ? "" : `${n > 0 ? "+" : n < 0 ? "-" : ""}${num(Math.abs(n), dp)}`);
const cls = (n: number | undefined) => (n === undefined || n === 0 ? "" : n > 0 ? "up" : "down");

/** Today's report in New York: gas on Thursday, petroleum on every other day (the Wednesday report is the one most days look back at). */
const defaultReport = (now: number): EiaReportCode => (new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" }).format(now) === "Thu" ? "WNGSR" : "WPSR");

const TITLE: Record<EiaReportCode, string> = { WPSR: "Petroleum (WPSR)", WNGSR: "Natural gas (WNGSR)" };
const dp = (r: EiaReportRow) => (r.unit === "million barrels" ? 3 : r.unit === "%" || r.unit === "Bcf" ? (r.unit === "%" ? 1 : 0) : 0);

function Line({ l }: { l: AnalysisLine }) {
  return (
    <li className={`er-line ${l.severity}`}>
      <i className="er-dot" title={l.severity === "flag" ? "worth a look" : l.severity === "note" ? "note" : "fact"} />
      <span>{l.text}</span>
    </li>
  );
}

function Tables({ rows, report }: { rows: EiaReportRow[]; report: EiaReportCode }) {
  const tables = useMemo(() => [...new Set(rows.map((r) => r.table))], [rows]);
  const [table, setTable] = useState<string>("");
  const current = tables.includes(table) ? table : tables[0] ?? "";
  const shown = rows.filter((r) => r.table === current);
  const gas = report === "WNGSR";
  let lastGroup: string | undefined;
  return (
    <div className="er-tables">
      {tables.length > 1 && (
        <div className="toolbar no-drag" role="group" aria-label="EIA table">
          {tables.map((t) => (
            <Button key={t} variant={t === current ? "default" : "ghost"} size="sm" onClick={() => setTable(t)}>
              {t}
            </Button>
          ))}
        </div>
      )}
      <table className="er-table">
        <thead>
          <tr>
            <th>{gas ? "Region" : "Row"}</th>
            <th>Level</th>
            <th>Prior</th>
            <th>Change</th>
            <th>Year ago</th>
            <th>{gas ? "5-yr avg" : "4-wk avg"}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const head = r.group !== lastGroup && r.group !== "";
            lastGroup = r.group;
            return [
              head && (
                <tr key={`g-${r.seriesId}`} className="er-group">
                  <td colSpan={6}>{r.group}</td>
                </tr>
              ),
              <tr key={r.seriesId} className={r.headline ? "headline" : ""}>
                <td className={r.parent ? "child" : ""} title={`${r.unit}${r.parent ? ` · under ${r.parent}` : ""}`}>
                  {r.label}
                </td>
                <td>{num(r.value, dp(r))}</td>
                <td>{num(r.prior, dp(r))}</td>
                <td className={cls(r.change)}>{signed(r.change, dp(r))}</td>
                <td title={r.yearAgoPct !== undefined ? `${signed(r.yearAgoPct, 1)}%` : undefined}>{num(r.yearAgo, dp(r))}</td>
                <td title={r.fiveYearPct !== undefined ? `${signed(r.fiveYearPct, 1)}% from it` : undefined}>{num(gas ? r.fiveYear : r.avg4, dp(r))}</td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The official EIA report as it comes out: the headline against the forecast, what moved it, every table, and how soon after the release we had it. */
export function EiaReportWidget(_: { widget: Widget }) {
  // a boolean state flips at the window edges only: a ticking clock here redrew all nine report tables every second (long tasks on the Report prep desk)
  const [windowOpen, setWindowOpen] = useState(() => inReleaseWindow(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setWindowOpen(inReleaseWindow(Date.now())), 1000);
    return () => clearInterval(id);
  }, []);
  const clock = useClock();
  const [report, setReport] = useState<EiaReportCode>(() => defaultReport(Date.now()));
  const [typed, setTyped] = useState("");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const [view, setView] = useState<"analysis" | "article" | "forecasts">("analysis");
  /** "" follows the newest stored report; a date shows that week (a report stored earlier, backfilled ones included) */
  const [week, setWeek] = useState("");
  const [weeks, setWeeks] = useState<StoredWeek[]>([]);
  const seenWeek = useRef<string | undefined>(undefined);

  const forecastParam = typed.trim() !== "" && Number.isFinite(Number(typed)) ? Number(typed) : undefined;
  const live = week === ""; // only the newest report is watched closely: an older one does not change

  // the weeks that can be picked, newest first; looked at again every minute so a report stored at the release appears
  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetch(`${apiUrl()}/eia-report/weeks?report=${report}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) return;
          const list = await res.json();
          setWeeks(Array.isArray(list) ? list : []); // anything but a list leaves the picker with just "Latest"
        })
        .catch(() => undefined);
    load();
    const id = setInterval(load, POLL_SLOW_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [report]);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () => {
      const q = new URLSearchParams({ report });
      if (week !== "") q.set("week", week);
      if (forecastParam !== undefined) q.set("forecast", String(forecastParam));
      fetch(`${apiUrl()}/eia-report?${q}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (res.status === 404) {
            setData(null);
            setError("No stored report yet. The watcher stores each one the moment it is released.");
            return;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const d: Loaded = await res.json();
          if (live && seenWeek.current !== undefined && seenWeek.current !== `${report}:${d.weekEnding}`) {
            setFresh(true);
            setTimeout(() => setFresh(false), 15_000);
          }
          seenWeek.current = `${report}:${d.weekEnding}`;
          setData(d);
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    };
    load();
    const id = setInterval(load, windowOpen && live ? POLL_FAST_MS : POLL_SLOW_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [report, week, live, forecastParam, windowOpen]);

  const a = data?.analysis;
  const h = a?.headline;
  return (
    <div className="eia-report">
      <div className="toolbar no-drag">
        {(Object.keys(TITLE) as EiaReportCode[]).map((r) => (
          <Button
            key={r} variant={r === report ? "default" : "ghost"} size="sm"
            onClick={() => {
              seenWeek.current = undefined;
              setWeek("");
              setData(null);
              setReport(r);
            }}
          >
            {TITLE[r]}
          </Button>
        ))}
        <label className="er-week no-drag">
          Week
          <Select aria-label="Week" value={week} onChange={(e) => (setData(null), setWeek(e.target.value))}>
            <option value="">{weeks[0] ? `Latest (${weeks[0].weekEnding})` : "Latest"}</option>
            {weeks.map((w) => (
              <option key={w.weekEnding} value={w.weekEnding}>
                {w.weekEnding}
                {w.backfilled ? " · stored later" : ""}
              </option>
            ))}
          </Select>
        </label>
        <label className="er-forecast">
          Forecast ({report === "WPSR" ? "MB" : "Bcf"})
          <Input inputMode="decimal" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={data?.forecast ? `${data.forecast.value} (${data.forecast.source ?? "recorded"})` : "type the number"} aria-label="Forecast of the change" />
        </label>
        <span className="er-views" role="group" aria-label="View">
          <Button variant={view === "analysis" ? "default" : "ghost"} size="sm" aria-pressed={view === "analysis"} onClick={() => setView("analysis")}>
            Analysis
          </Button>
          <Button variant={view === "article" ? "default" : "ghost"} size="sm" aria-pressed={view === "article"} onClick={() => setView("article")} title="A written article for this release: headline, context from history, what moved it, the market reaction">
            Article
          </Button>
          <Button variant={view === "forecasts" ? "default" : "ghost"} size="sm" aria-pressed={view === "forecasts"} onClick={() => setView("forecasts")} title="The forecasts against what came out, week by week, and how often the report-day rule's threshold was reached">
            Forecasts
          </Button>
        </span>
        {windowOpen && <span className="er-live" title="A release is due: looking every 3 seconds">watching</span>}
      </div>
      <EiaForecastsView report={report} active={view === "forecasts"} />
      <EiaArticleView report={report} week={week || undefined} forecast={forecastParam} active={view === "article"} />
      {view === "analysis" && !data && <p className="empty muted">{error ?? "Loading the report…"}</p>}
      {view === "analysis" && data && h && a && (
        <div className="er-body" tabIndex={0} role="region" aria-label="EIA report analysis">
          <div className={`er-headline${fresh ? " fresh" : ""}`}>
            <div>
              <div className="muted">{h.label}</div>
              <div className="er-big">
                <b className={cls(h.change)}>{signed(h.change, report === "WPSR" ? 3 : 0)}</b> <small>{h.unit}</small>
              </div>
              <div className="muted">
                level {num(h.level, report === "WPSR" ? 1 : 0)} {h.unit}
                {h.yearAgoPct !== undefined && ` · ${signed(h.yearAgoPct, 1)}% on a year ago`}
              </div>
            </div>
            <div className="er-sur">
              <div className="muted">Surprise vs forecast</div>
              <div className={`er-big ${h.passes ? (h.side === "long" ? "up" : "down") : ""}`}>{h.surprise === undefined ? "—" : signed(h.surprise, 1)}</div>
              <div className="muted">forecast {h.forecast === undefined ? "—" : signed(h.forecast, 1)} · threshold {num(h.threshold, 1)}</div>
            </div>
          </div>
          <p className={`er-side ${h.side === "long" ? "up" : h.side === "short" ? "down" : "muted"}`}>{h.sideText}</p>
          <p className="muted er-meta">
            Week ending {data.weekEnding}
            {data.officialReleaseAt && ` · released ${clock.stamp(data.officialReleaseAt)}`}
            {data.delayMs !== undefined && (data.backfilled ? " · stored later (catch-up)" : ` · stored ${(data.delayMs / 1000).toFixed(1)} s after the release`)}
          </p>
          {a.sections.map((s) => (
            <section key={s.id}>
              <h2>{s.title}</h2>
              <ul>
                {s.lines.map((l) => (
                  <Line key={l.id} l={l} />
                ))}
              </ul>
            </section>
          ))}
          <section>
            <h2>All tables</h2>
            <Tables rows={data.rows} report={report} />
          </section>
        </div>
      )}
    </div>
  );
}
