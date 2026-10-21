import { useEffect, useMemo, useRef, useState } from "react";
import type { EiaPoint, EiaSummary } from "@drishti/shared";
import { apiUrl, formatStamp, useSettings } from "./settings";
import type { Widget } from "./workspace";

type Row = EiaSummary & { label: string; unit: string; freq: string; group: string };

const REFRESH_MS = 10 * 60_000;
const GROUPS = ["Stocks", "Demand", "Spot"];

/** EIA open data: US stocks by product, refinery utilisation, product supplied and spot prices, against last week, last year and the five-year average. */
export function EiaWidget(_: { widget: Widget }) {
  const locale = useSettings((s) => s.locale);
  const clockSetting = useSettings((s) => s.clock);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const missing = useRef(false);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetch(`${apiUrl()}/eia`, { signal: ctrl.signal })
        .then(async (res) => {
          const json = await res.json();
          if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
          setRows(json.series);
          missing.current = json.series.some((r: Row) => !r.latest);
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    load();
    // EIA can take up to a minute for a series: while some are still missing, ask again every 5 s
    const id = setInterval(load, REFRESH_MS);
    const fill = setInterval(() => missing.current && load(), 5_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
      clearInterval(fill);
    };
  }, []);

  const nf = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }), [locale]);
  const num = (r: Row, v?: number) => (v === undefined ? "—" : nf.format(r.unit === "kb" || r.unit === "kb/d" ? Math.round(v) : v));
  const signed = (r: Row, v?: number) => (v === undefined ? "—" : `${v > 0 ? "+" : ""}${num(r, v)}`);
  // a stock build is bearish for price, a draw bullish: colour builds with the "down" colour only for stocks
  const tone = (r: Row, v?: number) => (v === undefined || v === 0 ? "muted" : (v > 0) === (r.group === "Stocks") ? "down" : "up");
  const day = (p: EiaPoint) => formatStamp(Date.parse(`${p.period}T00:00:00Z`), locale, clockSetting, "date", "UTC");

  return (
    <div className="eia">
      <div className="eia-body" tabIndex={0} role="region" aria-label="EIA petroleum data">
        {error && <p className="empty muted">{error}</p>}
        {!rows && !error && <p className="empty muted">Loading EIA data…</p>}
        {rows && (
          <table>
            <thead>
              <tr>
                <th>Series</th>
                <th>Latest</th>
                <th>Value</th>
                <th title="Change on the previous reading">Change</th>
                <th title="Change on the same week a year earlier">Year</th>
                <th title="Against the average of the same week in the previous five years">vs 5-yr avg</th>
              </tr>
            </thead>
            {GROUPS.map((g) => (
              <tbody key={g}>
                <tr className="eia-group">
                  <td colSpan={6}>{g}</td>
                </tr>
                {rows
                  .filter((r) => r.group === g)
                  .map((r) => (
                    <tr key={r.id}>
                      <td>{r.label}</td>
                      <td className="muted">{r.latest ? day(r.latest) : "—"}</td>
                      <td>
                        {num(r, r.latest?.value)} <small className="muted">{r.unit}</small>
                      </td>
                      <td className={tone(r, r.change)}>{signed(r, r.change)}</td>
                      <td className={tone(r, r.yoyChange)}>{signed(r, r.yoyChange)}</td>
                      <td className={tone(r, r.vsFiveYear)} title={r.fiveYearAvg === undefined ? undefined : `five-year average ${num(r, r.fiveYearAvg)}`}>
                        {signed(r, r.vsFiveYear)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            ))}
          </table>
        )}
        <p className="muted eia-note">Source: US EIA open data. Stock builds show in the down colour (bearish for price) and draws in the up colour. Weekly stocks are for the week ending the date shown.</p>
      </div>
    </div>
  );
}
