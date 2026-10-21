import { useEffect, useMemo, useState } from "react";
import { COT_MARKETS, cotPublishedAt, instrument, netChange, percentileRank, type CotGroup, type CotMarketId, type CotRow } from "@drishti/shared";
import { apiUrl, formatStamp, useSettings } from "./settings";
import { sparkPoints } from "./spark";
import { useWidgetSymbol, type Widget } from "./workspace";

const RANGES = [
  ["1y", 52],
  ["3y", 156],
] as const;

const GROUPS: { key: "managedMoney" | "producers" | "swapDealers" | "otherReportable" | "nonReportable"; label: string; hint: string }[] = [
  { key: "managedMoney", label: "Managed money", hint: "Hedge funds and commodity trading advisors: the speculators" },
  { key: "producers", label: "Producers / merchants", hint: "Physical producers, merchants, processors and users: the hedgers" },
  { key: "swapDealers", label: "Swap dealers", hint: "Banks and dealers hedging swaps sold to clients" },
  { key: "otherReportable", label: "Other reportable", hint: "Other large traders" },
  { key: "nonReportable", label: "Small traders", hint: "Positions below the CFTC reporting level" },
];

/** CFTC Commitments of Traders: who is long and short WTI, Brent, RBOB and Henry Hub, weekly. */
export function CotWidget({ widget }: { widget: Widget }) {
  const linked = instrument(useWidgetSymbol(widget))?.topic === "natgas" ? "natgas" : "wti";
  const locale = useSettings((s) => s.locale);
  const clockSetting = useSettings((s) => s.clock);
  const [market, setMarket] = useState<CotMarketId | null>(null);
  const [weeks, setWeeks] = useState<number>(156);
  const [rows, setRows] = useState<CotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = market ?? linked;

  useEffect(() => {
    const ctrl = new AbortController();
    setRows(null);
    setError(null);
    fetch(`${apiUrl()}/cot?market=${active}&weeks=156`, { signal: ctrl.signal })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
        setRows(json.rows);
      })
      .catch((e) => e.name !== "AbortError" && setError(e.message));
    return () => ctrl.abort();
  }, [active]);

  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const signed = (v: number) => `${v > 0 ? "+" : ""}${nf.format(v)}`;
  // the report date is a calendar day (Tuesday), and it is published on a New York afternoon: show each in its own zone so no viewer sees the wrong day
  const reportDay = (t: number) => formatStamp(t, locale, clockSetting, "date", "UTC");
  const publishedDay = (t: number) => formatStamp(t, locale, clockSetting, "date", "America/New_York");

  const shown = rows?.slice(-weeks) ?? [];
  const last = rows?.[rows.length - 1];
  const mmHistory = (rows ?? []).map((r) => r.managedMoney.net);
  const rank = last ? percentileRank(last.managedMoney.net, mmHistory) : undefined;
  const mmChange = last ? netChange(last.managedMoney) : undefined;
  const pts = sparkPoints(shown.map((r) => r.managedMoney.net), 600, 90);
  const lo = Math.min(0, ...shown.map((r) => r.managedMoney.net));
  const hi = Math.max(0, ...shown.map((r) => r.managedMoney.net));
  const zeroY = hi === lo ? 45 : 90 - ((0 - lo) / (hi - lo)) * 90;

  return (
    <div className="cot">
      <div className="toolbar no-drag">
        {COT_MARKETS.map((m) => (
          <button key={m.id} className={m.id === active ? "tf active" : "tf"} title={m.name} onClick={() => setMarket(m.id)}>
            {m.id === "natgas" ? "Nat gas" : m.id === "wti" ? "WTI" : m.id === "brent" ? "Brent" : "RBOB"}
          </button>
        ))}
        {RANGES.map(([label, w]) => (
          <button key={label} className={w === weeks ? "tf active" : "tf"} onClick={() => setWeeks(w)}>
            {label}
          </button>
        ))}
      </div>
      <div className="cot-body" tabIndex={0} role="region" aria-label="Commitments of Traders">
        {error && <p className="empty muted">{error}</p>}
        {!rows && !error && <p className="empty muted">Loading CFTC positions…</p>}
        {last && (
          <>
            <p className="muted cot-asof">
              {COT_MARKETS.find((m) => m.id === active)?.name} · positions as of <b>{reportDay(last.date)}</b>, published {publishedDay(cotPublishedAt(last.date))} · open interest {nf.format(last.openInterest)}
            </p>
            <div className="cot-head">
              <div>
                <span className="muted">Managed money net</span>
                <strong className={last.managedMoney.net >= 0 ? "up" : "down"}>{signed(last.managedMoney.net)}</strong>
                {mmChange !== undefined && <small className={mmChange >= 0 ? "up" : "down"}>{signed(mmChange)} this week</small>}
              </div>
              {rank !== undefined && (
                <div title="Share of the last three years of weeks in which speculators were no more net long than now">
                  <span className="muted">Position vs 3 years</span>
                  <strong>{Math.round(rank)}th percentile</strong>
                  <span className="cot-rank">
                    <span style={{ left: `${rank}%` }} />
                  </span>
                </div>
              )}
            </div>
            <svg className="cot-chart" viewBox="0 0 600 90" preserveAspectRatio="none" role="img" aria-label="Managed money net position history">
              <line x1="0" x2="600" y1={zeroY} y2={zeroY} stroke="var(--line)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
              <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Long</th>
                  <th>Short</th>
                  <th>Net</th>
                  <th>Net chg</th>
                  <th title="Share of open interest held long and short">% OI L / S</th>
                </tr>
              </thead>
              <tbody>
                {GROUPS.map(({ key, label, hint }) => {
                  const g: CotGroup = last[key];
                  const ch = netChange(g);
                  return (
                    <tr key={key}>
                      <td title={hint}>{label}</td>
                      <td>{nf.format(g.long)}</td>
                      <td>{nf.format(g.short)}</td>
                      <td className={g.net >= 0 ? "up" : "down"}>{signed(g.net)}</td>
                      <td className={ch === undefined ? "muted" : ch >= 0 ? "up" : "down"}>{ch === undefined ? "—" : signed(ch)}</td>
                      <td className="muted">
                        {((g.long / last.openInterest) * 100).toFixed(1)} / {((g.short / last.openInterest) * 100).toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted cot-note">Contracts, futures only. Published Fridays 3:30 pm New York for the Tuesday before, so the picture is a few days old.</p>
          </>
        )}
      </div>
    </div>
  );
}
