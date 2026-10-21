import { useEffect, useMemo, useState } from "react";
import { CHOKEPOINTS, rollingTankers, type ChokepointId, type Flow, type TransitDay, type TransitSummary } from "@drishti/shared";
import { Outdated } from "./Outdated";
import { apiUrl, formatStamp, useSettings } from "./settings";
import { sparkPoints } from "./spark";
import type { Widget } from "./workspace";

interface Reply {
  days: TransitDay[];
  summary?: TransitSummary;
}

const FLOW_LABEL: Record<Flow, string> = { normal: "Normal", reduced: "Reduced", disrupted: "Disrupted", unknown: "—" };
const FLOW_CLASS: Record<Flow, string> = { normal: "up", reduced: "warn", disrupted: "down", unknown: "muted" };

/** IMF PortWatch: tankers per day through the sea lanes oil and gas depend on, against the same weeks a year ago. */
export function ChokepointsWidget(_: { widget: Widget }) {
  const locale = useSettings((s) => s.locale);
  const clockSetting = useSettings((s) => s.clock);
  const [active, setActive] = useState<ChokepointId>("hormuz");
  const [data, setData] = useState<Partial<Record<ChokepointId, Reply>>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    for (const c of CHOKEPOINTS) {
      fetch(`${apiUrl()}/chokepoints?id=${c.id}&days=400`, { signal: ctrl.signal })
        .then(async (res) => {
          const json = await res.json();
          if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
          setData((d) => ({ ...d, [c.id]: json }));
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    }
    return () => ctrl.abort();
  }, []);

  const nf = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const day = (iso: string) => formatStamp(Date.parse(`${iso}T00:00:00Z`), locale, clockSetting, "date", "UTC");
  const cur = data[active];
  const s = cur?.summary;
  const line = useMemo(() => rollingTankers(cur?.days ?? []), [cur]);
  const pts = sparkPoints(line, 600, 90);
  const top = Math.max(0, ...line);

  return (
    <div className="chk">
      <div className="chk-body" tabIndex={0} role="region" aria-label="Shipping chokepoints">
        {error && !cur && <p className="empty muted">{error}</p>}
        {!cur && !error && <p className="empty muted">Loading transits…</p>}
        <table>
          <thead>
            <tr>
              <th>Chokepoint</th>
              <th title="Tankers per day, average of the last 30 days">Tankers/day</th>
              <th title="Last 30 days against the same 30 days a year earlier">vs year ago</th>
              <th>Flow</th>
            </tr>
          </thead>
          <tbody>
            {CHOKEPOINTS.map((c) => {
              const sm = data[c.id]?.summary;
              return (
                <tr key={c.id} className={c.id === active ? "active" : ""} onClick={() => setActive(c.id)} title={c.why}>
                  <td>{c.name}</td>
                  <td>{sm?.avg30 === undefined ? "…" : nf.format(sm.avg30)}</td>
                  <td className={sm?.vsYearAgoPct === undefined ? "muted" : sm.vsYearAgoPct >= 0 ? "up" : "down"}>
                    {sm?.vsYearAgoPct === undefined ? "—" : `${sm.vsYearAgoPct > 0 ? "+" : ""}${nf.format(sm.vsYearAgoPct)}%`}
                  </td>
                  <td className={sm ? FLOW_CLASS[sm.flow] : "muted"}>{sm ? FLOW_LABEL[sm.flow] : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {s && (
          <>
            <p className="muted chk-asof">
              {CHOKEPOINTS.find((c) => c.id === active)?.name} · 7-day average of tankers per day · data to <b>{day(s.asOf)}</b> (published weekly, a few days behind) <Outdated kind="transits" asOf={Date.parse(`${s.asOf}T00:00:00Z`)} />
            </p>
            <svg className="chk-chart" viewBox="0 0 600 90" preserveAspectRatio="none" role="img" aria-label="Tankers per day, 7-day average">
              <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
            <p className="muted chk-scale">
              peak {nf.format(top)} · last 7 days {s.avg7 === undefined ? "—" : nf.format(s.avg7)} · a year ago {s.avg30YearAgo === undefined ? "—" : nf.format(s.avg30YearAgo)} tankers/day
            </p>
          </>
        )}
        <p className="muted chk-note">Source: IMF PortWatch, from satellite ship tracking. Tanker counts, not barrels.</p>
      </div>
    </div>
  );
}
