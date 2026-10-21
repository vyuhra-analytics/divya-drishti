import { useEffect, useMemo, useState } from "react";
import { JODI_COUNTRIES, type JodiCountry, type JodiSeries } from "@drishti/shared";
import { apiUrl, useSettings } from "./settings";
import { sparkPoints } from "./spark";
import type { Widget } from "./workspace";

const QUALITY = { 1: "Good quality data", 2: "Fair quality data", 3: "Less reliable data (JODI assessment 3)" } as const;

/** JODI Oil World: a country's monthly crude balance (production, imports, exports, refinery intake, stocks), each with its own latest reported month. */
export function JodiWidget(_: { widget: Widget }) {
  const locale = useSettings((s) => s.locale);
  const [country, setCountry] = useState<JodiCountry>("IN");
  const [flows, setFlows] = useState<JodiSeries[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setFlows(null);
    setError(null);
    fetch(`${apiUrl()}/jodi?country=${country}`, { signal: ctrl.signal })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
        setFlows(json.flows);
      })
      .catch((e) => e.name !== "AbortError" && setError(e.message));
    return () => ctrl.abort();
  }, [country]);

  const nf = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
  const pf = (v?: number) => (v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  const cls = (v?: number) => (v === undefined ? "muted" : v >= 0 ? "up" : "down");
  const month = (m: string) => new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" }).format(Date.parse(`${m}-01T00:00:00Z`));
  const reported = flows?.filter((f) => f.latest) ?? [];
  const missing = flows?.filter((f) => !f.latest).map((f) => f.label.toLowerCase()) ?? [];

  return (
    <div className="jodi">
      <div className="toolbar no-drag">
        {JODI_COUNTRIES.map((c) => (
          <button key={c.code} className={c.code === country ? "tf active" : "tf"} title={c.name} onClick={() => setCountry(c.code)}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="jodi-body" tabIndex={0} role="region" aria-label="JODI crude oil balance">
        {error && <p className="empty muted">{error}</p>}
        {!flows && !error && <p className="empty muted">Loading JODI data…</p>}
        {flows && reported.length === 0 && <p className="empty muted">This country has not reported crude data to JODI recently.</p>}
        {reported.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Crude oil</th>
                <th>Latest month</th>
                <th title="Flows in thousand barrels a day; stocks in thousand barrels">Value</th>
                <th title="Change on the month before">Month</th>
                <th title="Change on the same month a year earlier">Year</th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              {reported.map((f) => (
                <tr key={f.flow}>
                  <td title={f.latest ? QUALITY[f.latest.quality as 1 | 2 | 3] : undefined}>{f.label}</td>
                  <td className="muted">{month(f.latest!.month)}</td>
                  <td>
                    {nf.format(f.latest!.value)} <small className="muted">{f.unit === "KBD" ? "kb/d" : "kb"}</small>
                  </td>
                  <td className={cls(f.momPct)}>{pf(f.momPct)}</td>
                  <td className={cls(f.yoyPct)}>{pf(f.yoyPct)}</td>
                  <td>
                    <svg className="jodi-spark" viewBox="0 0 80 22" preserveAspectRatio="none" role="img" aria-label={`${f.label} trend`}>
                      <polyline points={sparkPoints(f.series.map((p) => p.value), 80, 22)} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                    </svg>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {missing.length > 0 && reported.length > 0 && <p className="muted jodi-note">Not reported to JODI: {missing.join(", ")}.</p>}
        <p className="muted jodi-note">Source: JODI Oil World, official figures from governments. Countries report with a lag (India about 6 months), so each row carries its own latest month. kb/d = thousand barrels a day.</p>
      </div>
    </div>
  );
}
