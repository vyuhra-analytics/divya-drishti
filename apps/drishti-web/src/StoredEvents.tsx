import { useEffect, useState } from "react";
import { apiUrl, useClock, useSettings } from "./settings";

interface Obs {
  kind: "forecast" | "previous" | "actual" | "revised";
  text: string;
  num: number | null;
  source: string;
  observedAt: string;
  backfilled: boolean;
}

interface Stored {
  id: string;
  series_code: string;
  scheduled_at: string;
  title: string;
  period: string | null;
  status: string;
  observations: Obs[];
}

interface EiaRow {
  seriesId: string;
  label: string;
  unit: string;
  headline: boolean;
  value: number;
  prior: number | null;
  change: number | null;
}

const DAY = 86_400_000;
const REFRESH_MS = 60_000;

/** The newest figure of a kind: the log is in the order seen, so the last one is what is believed now. */
export const latestOf = (obs: Obs[], kind: Obs["kind"]) => obs.filter((o) => o.kind === kind).at(-1);

/** Actual minus forecast, when both are numbers in the same unit. */
export function surprise(obs: Obs[]): number | undefined {
  const a = latestOf(obs, "actual");
  const f = latestOf(obs, "forecast");
  return a?.num != null && f?.num != null ? Math.round((a.num - f.num) * 1e6) / 1e6 : undefined;
}

const EIA_REPORTS = new Set(["WPSR", "WNGSR"]);

function EiaTable({ id }: { id: string }) {
  const [rows, setRows] = useState<EiaRow[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${apiUrl()}/calendar/stored/${id}/eia`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setRows)
      .catch(() => {});
    return () => ctrl.abort();
  }, [id]);
  if (!rows) return <p className="muted">Loading the report table…</p>;
  if (rows.length === 0) return <p className="muted">No table stored for this release.</p>;
  return (
    <table className="st-eia">
      <thead>
        <tr>
          <th>Series</th>
          <th>Level ({rows[0].unit})</th>
          <th>Prior</th>
          <th>Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.seriesId} className={r.headline ? "headline" : ""}>
            <td>{r.label}</td>
            <td>{r.value}</td>
            <td>{r.prior ?? ""}</td>
            <td className={r.change == null || r.change === 0 ? "" : r.change > 0 ? "up" : "down"}>{r.change == null ? "" : `${r.change > 0 ? "+" : ""}${Math.round(r.change * 1000) / 1000}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What the recorder has stored: every release of the last 30 days and the next two weeks, with the figures as they were seen. */
export function StoredEvents() {
  const [rows, setRows] = useState<Stored[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const clock = useClock();
  const locale = useSettings((s) => s.locale);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () => {
      const now = Date.now();
      const q = new URLSearchParams({ from: new Date(now - 30 * DAY).toISOString(), to: new Date(now + 14 * DAY).toISOString() });
      fetch(`${apiUrl()}/calendar/stored?${q}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setRows(await res.json());
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, []);

  if (!rows) return <p className="empty muted">{error ? `Stored events unavailable: ${error}` : "Loading stored events…"}</p>;
  if (rows.length === 0) return <p className="empty muted">Nothing stored yet. The recorder fills this in a few minutes after the API starts.</p>;

  const dayOf = (t: number) => new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(t).replace(/,/g, "");
  return (
    <div className="calendar-list" tabIndex={0} role="region" aria-label="Stored calendar events">
      <div className="cal-day">
        <h2>Newest first</h2>
        <span>Actual</span>
        <span>Previous</span>
        <span>Forecast</span>
      </div>
      {rows.map((r) => {
        const at = Date.parse(r.scheduled_at);
        const actual = latestOf(r.observations, "actual");
        const forecast = latestOf(r.observations, "forecast");
        const previous = latestOf(r.observations, "previous");
        const s = surprise(r.observations);
        const isOpen = open === r.id;
        return (
          <div key={r.id}>
            <div className={`cal-row${r.status === "released" ? "" : " past"}`}>
              <span className="cal-time" title={r.status}>{clock.time(at)}</span>
              <span className="cal-country" />
              <span className="cal-body">
                <span className="cal-title">
                  {r.title}
                  {r.period && <small>{r.period}</small>}
                </span>
                <span className="muted cal-detail">
                  {dayOf(at)} · {r.series_code} · {r.status}
                  {s !== undefined && s !== 0 && <b className={s > 0 ? "up" : "down"}> · {s > 0 ? "+" : ""}{s} vs forecast</b>}
                </span>
              </span>
              <span className="cal-actual" title={actual ? `source: ${actual.source}` : ""}>{actual?.text ?? ""}</span>
              <span className="cal-prev">{previous?.text ?? ""}</span>
              <span className="cal-fc" title={forecast ? `source: ${forecast.source}` : ""}>{forecast?.text ?? ""}</span>
              <button className="cal-bell on" aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} history of ${r.title}`} title="Every figure seen for this release" onClick={() => setOpen(isOpen ? null : r.id)}>
                {isOpen ? "▾" : "▸"}
              </button>
            </div>
            {isOpen && (
              <div className="st-detail">
                {r.observations.length === 0 && <p className="muted">No figures recorded.</p>}
                {r.observations.map((o, i) => (
                  <div key={i} className="st-obs">
                    <span className="muted">{o.kind}</span>
                    <b>{o.text}</b>
                    <span className="muted">
                      {o.source} · seen {new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(Date.parse(o.observedAt))} {clock.time(Date.parse(o.observedAt))}
                      {o.backfilled ? " · backfilled" : ""}
                    </span>
                  </div>
                ))}
                {EIA_REPORTS.has(r.series_code) && r.status === "released" && <EiaTable id={r.id} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
