import { Fragment, useEffect, useState } from "react";
import type { Cell, EiaKey, EiaReportCode, ForecastRelease, ForecastTable, GasForecastTable, RuleStats, SeriesStats } from "@drishti/shared";
import { apiUrl } from "./settings";
import { Button } from "./ui";

type Loaded = ForecastTable & { threshold: number };

const RANGES = [26, 52, 100, 260, 520] as const;
const RANGE_NAME: Record<number, string> = { 260: "5 years", 520: "10 years" };
const NAMES: Record<EiaKey | "api", string> = { crude: "Crude", gasoline: "Gasoline", distillates: "Distillates", api: "API crude" };
const ORDER = ["crude", "gasoline", "distillates", "api"] as const;

const num = (v: number | undefined, signed = false) => (v === undefined ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(2)}`);
/** a crude surprise that reaches the report-day rule's threshold takes the colour of the side the rule allows (a draw below forecast = long = up) */
const sideClass = (s: number | undefined, threshold: number) => (s === undefined || Math.abs(s) < threshold ? "" : s < 0 ? "up" : "down");

function Stat({ name, s, rule, unit = "million barrels" }: { name: string; s: SeriesStats | undefined; rule?: RuleStats; unit?: string }) {
  return (
    <div className="ef-stat">
      <b>{name}</b>
      {s ? (
        <>
          <span title={`Average miss: how far the actual was from the forecast, in ${unit}`}>miss {s.meanAbs.toFixed(2)}</span>
          <span title="Average surprise: negative means the market drew more than the forecasts expected">bias {num(s.bias, true)}</span>
          <span className="muted">{s.n} weeks</span>
        </>
      ) : (
        <span className="muted">no data</span>
      )}
      {rule && (
        <span className="ef-rule" title={`Weeks the surprise reached ${rule.threshold.toFixed(1)} ${unit}, which is when the app's report-day rule allows a side: a draw below forecast is long, above is short`}>
          rule reached {rule.reached} of {rule.of}: <span className="up">{rule.long} long</span>, <span className="down">{rule.short} short</span>
        </span>
      )}
    </div>
  );
}

function Cells({ c, threshold, withActual, highlight }: { c: Cell; threshold: number; withActual: boolean; highlight: boolean }) {
  return (
    <>
      <td>{num(c.forecast, true)}</td>
      {withActual && (
        <td title={c.actualFrom === "investing" ? "From Investing.com: no stored report for this week" : c.actualFrom === "published" ? "The figure in EIA's published report" : undefined}>
          {num(c.actual, true)}
          {c.actualFrom === "investing" && <sup>†</sup>}
        </td>
      )}
      <td className={highlight ? sideClass(c.surprise, threshold) : ""}>{num(c.surprise, true)}</td>
    </>
  );
}

/**
 * The forecasts of the weekly releases against what came out: how the consensus has done, how often the report-day rule's threshold was reached, and a
 * row per release (the next one on top with its forecast only). Forecasts are Investing.com's consensus; actuals are EIA's published reports.
 */
export function EiaForecastsView({ report, active }: { report: EiaReportCode; active: boolean }) {
  const [weeks, setWeeks] = useState<(typeof RANGES)[number]>(52);
  const [data, setData] = useState<Loaded | null>(null);
  const [gas, setGas] = useState<(GasForecastTable & { threshold: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    setData(null);
    setGas(null);
    const ctrl = new AbortController();
    const load = () =>
      fetch(`${apiUrl()}/eia-report/forecasts?weeks=${weeks}${report === "WNGSR" ? "&report=WNGSR" : ""}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          if (report === "WNGSR") setGas(body);
          else setData(body);
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    load();
    const id = setInterval(load, 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [active, report, weeks]);

  if (!active) return null;
  if (report === "WNGSR") return <GasView gas={gas} error={error} weeks={weeks} setWeeks={setWeeks} />;
  if (!data) return <p className="empty muted">{error ?? "Loading the forecasts…"}</p>;

  const day = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/New_York" });
  return (
    <div className="ef">
      <div className="toolbar no-drag" role="group" aria-label="Weeks shown">
        {RANGES.map((r) => (
          <Button key={r} variant={r === weeks ? "default" : "ghost"} size="sm" onClick={() => setWeeks(r)}>
            {RANGE_NAME[r] ?? `${r} weeks`}
          </Button>
        ))}
        <span className="muted ef-src">Forecasts: Investing.com consensus (third-party). Actuals: EIA's published reports. Million barrels; surprise = actual minus forecast.</span>
      </div>
      <div className="er-body" tabIndex={0} role="region" aria-label="Forecasts against actuals">
        <div className="ef-stats">
          {ORDER.map((k) => (
            <Stat key={k} name={NAMES[k]} s={data.stats[k]} rule={k === "crude" ? data.rule : undefined} />
          ))}
        </div>
        {data.releases.length === 0 ? (
          <p className="empty muted">No forecasts stored yet. They are read from Investing.com a few times a day (INVESTING_FORECASTS=off stops that).</p>
        ) : (
          <table className="er-table ef-table">
            <thead>
              <tr>
                <th rowSpan={2}>Release (New York)</th>
                {ORDER.map((k) => (
                  <th key={k} colSpan={3}>
                    {NAMES[k]}
                  </th>
                ))}
              </tr>
              <tr>
                {ORDER.map((k) => (
                  <Fragment key={k}>
                    <th>Fcst</th>
                    <th>Actual</th>
                    <th>Surprise</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.releases.map((r: ForecastRelease) => {
                const reached = r.crude.surprise !== undefined && Math.abs(r.crude.surprise) >= data.threshold;
                return (
                  <tr key={r.releaseAt} className={r.upcoming ? "next" : reached ? "reached" : ""}>
                    <td>
                      {day(r.releaseAt)}
                      {r.upcoming && <small className="muted"> next</small>}
                    </td>
                    {ORDER.map((k) => (
                      <Cells key={k} c={r[k]} threshold={data.threshold} withActual highlight={k === "crude"} />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted ef-foot">
          † the figure on Investing.com's page, for a week with no stored report (the API's own figures are not published free, so its actual is always the page's). A shaded row is a crude surprise of {data.threshold.toFixed(1)} or more.
        </p>
      </div>
    </div>
  );
}

function GasView({ gas, error, weeks, setWeeks }: { gas: (GasForecastTable & { threshold: number }) | null; error: string | null; weeks: number; setWeeks: (w: (typeof RANGES)[number]) => void }) {
  if (!gas) return <p className="empty muted">{error ?? "Loading the forecasts…"}</p>;
  const day = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/New_York" });
  return (
    <div className="ef">
      <div className="toolbar no-drag" role="group" aria-label="Weeks shown">
        {RANGES.map((r) => (
          <Button key={r} variant={r === weeks ? "default" : "ghost"} size="sm" onClick={() => setWeeks(r)}>
            {RANGE_NAME[r] ?? `${r} weeks`}
          </Button>
        ))}
        <span className="muted ef-src">Forecasts and actuals: Investing.com (third-party; EIA keeps no archive of past gas reports). Bcf; surprise = actual minus forecast.</span>
      </div>
      <div className="er-body" tabIndex={0} role="region" aria-label="Gas storage forecasts against actuals">
        <div className="ef-stats">
          <Stat name="Gas storage" s={gas.stats} rule={gas.rule} unit="Bcf" />
        </div>
        {gas.releases.length === 0 ? (
          <p className="empty muted">No gas storage forecasts stored yet.</p>
        ) : (
          <table className="er-table ef-table">
            <thead>
              <tr>
                <th>Release (New York)</th>
                <th>Fcst</th>
                <th>Actual</th>
                <th>Surprise</th>
              </tr>
            </thead>
            <tbody>
              {gas.releases.map((r) => {
                const reached = r.storage.surprise !== undefined && Math.abs(r.storage.surprise) >= gas.threshold;
                return (
                  <tr key={r.releaseAt} className={r.upcoming ? "next" : reached ? "reached" : ""}>
                    <td>
                      {day(r.releaseAt)}
                      {r.upcoming && <small className="muted"> next</small>}
                    </td>
                    <Cells c={r.storage} threshold={gas.threshold} withActual highlight />
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted ef-foot">† the figure on Investing.com's page. A shaded row is a surprise of {gas.threshold.toFixed(1)} Bcf or more: storage below forecast is long, above is short.</p>
      </div>
    </div>
  );
}
