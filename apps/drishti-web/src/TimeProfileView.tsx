import { Fragment, useEffect, useMemo, useState } from "react";
import { PROFILE_UNDERLYINGS, type ProfileUnderlying, type TimeProfile, type WindowProfile, type ZoneDay } from "@drishti/shared";
import { apiUrl } from "./settings";

const DAYS = [30, 60, 90] as const;
const pct = (v: number | undefined, d = 3) => (v === undefined ? "—" : `${v.toFixed(d)}%`);

/**
 * When the market is busy: each named window of the New York day (the five ICT killzones and the gaps between them) with its average range, how active an
 * average minute is, volume and spread, and the high, low, range and average of every window on the latest days. From our own one-minute candles and
 * recorded feed. Descriptive only: it says when the market moves, not which way.
 */
export function TimeProfileView() {
  const [underlying, setUnderlying] = useState<ProfileUnderlying>("CRUDEOILM");
  const [days, setDays] = useState<(typeof DAYS)[number]>(60);
  const [data, setData] = useState<TimeProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setData(null);
    setError(null);
    fetch(`${apiUrl()}/research/time-profile?underlying=${underlying}&days=${days}&recent=3`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? `HTTP ${res.status}`);
        setData(await res.json());
      })
      .catch((e) => e.name !== "AbortError" && setError(e.message));
    return () => ctrl.abort();
  }, [underlying, days]);

  const busiest = useMemo(() => (data?.windows.length ? [...data.windows].sort((a, b) => b.avgBarRangePct - a.avgBarRangePct)[0] : undefined), [data]);
  const top = busiest?.avgBarRangePct ?? 0;
  const mean = (ws: WindowProfile[]) => (ws.length ? ws.reduce((a, w) => a + w.avgBarRangePct, 0) / ws.length : undefined);
  const kz = data ? mean(data.windows.filter((w) => w.killzone)) : undefined;
  const gaps = data ? mean(data.windows.filter((w) => !w.killzone)) : undefined;
  const byDay = useMemo(() => {
    const m = new Map<string, ZoneDay[]>();
    for (const z of data?.recent ?? []) m.set(z.day, [...(m.get(z.day) ?? []), z]);
    return [...m].reverse();
  }, [data]);

  return (
    <div className="bt">
      <div className="bt-body" tabIndex={0} role="region" aria-label="Time of day profile">
        <div className="costs-form no-drag">
          <label>
            Contract
            <select value={underlying} onChange={(ev) => setUnderlying(ev.target.value as ProfileUnderlying)}>
              {PROFILE_UNDERLYINGS.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </label>
          <label>
            Last (days)
            <select value={days} onChange={(ev) => setDays(Number(ev.target.value) as (typeof DAYS)[number])}>
              {DAYS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
        </div>
        {!data ? (
          <p className="empty muted">{error ?? "Loading the profile…"}</p>
        ) : data.windows.length === 0 ? (
          <p className="empty muted">No one-minute candles stored for {underlying} in that period.</p>
        ) : (
          <>
            <p className="muted bt-asof">
              {underlying} · {data.days} New York days, {data.from} to {data.to} · one-minute candles of the most traded contract each day · spreads from {data.spreadDays} day{data.spreadDays === 1 ? "" : "s"} of recorded quotes
            </p>
            <div className="bt-verdict up">
              <strong>Busiest window: {busiest?.label}</strong>
              <ul>
                <li>
                  The range of an average minute: killzones {pct(kz)}, the gaps between them {pct(gaps)}. {kz !== undefined && gaps !== undefined && (kz > gaps * 1.1 ? "The killzones are busier." : kz < gaps * 0.9 ? "The gaps are busier: the killzone labels do not mark the busiest hours here." : "No clear difference.")}
                </li>
                <li>Hours are New York time (add 9:30 for IST in US daylight time, 10:30 in winter). The Asian window is missing because MCX trades only its last half hour.</li>
              </ul>
            </div>
            <table className="bt-num ef-table">
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Days</th>
                  <th title="Average high-low range of the window, in price points and as a percentage of price">Avg range</th>
                  <th title="The high-low range of an average minute as a percentage of price: comparable between a short window and a long one. Minutes with no trade count as zero.">Activity / min</th>
                  <th title="Contracts traded per minute">Volume / min</th>
                  <th title="Average bid-ask spread as a percentage of the mid price, from our recording of the feed">Spread</th>
                </tr>
              </thead>
              <tbody>
                {data.windows.map((w) => (
                  <tr key={w.window} className={w.window === busiest?.window ? "next" : ""}>
                    <td>
                      {w.label} {w.killzone && <small className="muted">killzone</small>}
                    </td>
                    <td>{w.days}</td>
                    <td>
                      {w.avgRange.toFixed(1)} <small className="muted">({pct(w.avgRangePct, 2)})</small>
                    </td>
                    <td>
                      <span className="tp-bar" style={{ display: "inline-block", width: `${top > 0 ? Math.round((w.avgBarRangePct / top) * 60) : 0}px`, height: "8px", background: "var(--accent-fill)", marginRight: 6 }} />
                      {pct(w.avgBarRangePct)}
                    </td>
                    <td>{w.volumePerMin.toFixed(1)}</td>
                    <td title={`${w.spreadRows} quotes`}>{pct(w.spreadPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h2>Latest days: high, low, range and average of each window</h2>
            <table className="bt-num ef-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Window</th>
                  <th>High</th>
                  <th>Low</th>
                  <th>Range</th>
                  <th>Average</th>
                </tr>
              </thead>
              <tbody>
                {byDay.map(([day, zs]) => (
                  <Fragment key={day}>
                    {zs.map((z, i) => (
                      <tr key={`${day}-${z.window}`}>
                        <td>{i === 0 ? day : ""}</td>
                        <td>
                          {z.label} {z.killzone && <small className="muted">killzone</small>}
                        </td>
                        <td>{z.high.toFixed(1)}</td>
                        <td>{z.low.toFixed(1)}</td>
                        <td>{z.range.toFixed(1)}</td>
                        <td>{z.average.toFixed(1)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </>
        )}
        <p className="muted bt-note">Descriptive: it shows when the market moves, not which way. A window needs most of its minutes in the candles to count on a day. Past activity does not predict future activity; no order is ever placed.</p>
      </div>
    </div>
  );
}
