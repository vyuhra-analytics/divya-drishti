import { useEffect, useMemo, useState } from "react";
import { INSTRUMENTS, instrument, type CurvePoint, type CurveSummary } from "@drishti/shared";
import { apiUrl, formatStamp, useSettings } from "./settings";
import { sparkPoints } from "./spark";
import { useWidgetSymbol, type Widget } from "./workspace";

interface Reply {
  points: CurvePoint[];
  summary?: CurveSummary;
}

const REFRESH_MS = 15_000;
const SHAPE_CLASS = { contango: "warn", backwardation: "up", flat: "muted" } as const;

/** Futures curve: price per delivery month, calendar spreads and whether the market is in contango or backwardation. */
export function CurveWidget({ widget }: { widget: Widget }) {
  const linked = useWidgetSymbol(widget);
  const locale = useSettings((s) => s.locale);
  const clockSetting = useSettings((s) => s.clock);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [data, setData] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = symbol ?? linked;
  const inst = instrument(active);
  const decimals = inst?.decimals ?? 2;

  useEffect(() => {
    const ctrl = new AbortController();
    setData(null);
    setError(null);
    const load = () =>
      fetch(`${apiUrl()}/curve?symbol=${encodeURIComponent(active)}`, { signal: ctrl.signal })
        .then(async (res) => {
          const json = await res.json();
          if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
          setData(json);
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [active]);

  const nf = useMemo(() => new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }), [locale, decimals]);
  const signed = (v: number) => `${v > 0 ? "+" : ""}${nf.format(v)}`;
  const month = (t: number) => new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" }).format(t);
  const day = (t: number) => formatStamp(t, locale, clockSetting, "date", "UTC");

  const pts = data?.points ?? [];
  const s = data?.summary;
  const line = sparkPoints(pts.map((p) => p.price), 600, 90);

  return (
    <div className="curve">
      <div className="toolbar no-drag">
        {INSTRUMENTS.map((i) => (
          <button key={i.symbol} className={i.symbol === active ? "tf active" : "tf"} title={i.name} onClick={() => setSymbol(i.symbol)}>
            {i.symbol.split(":")[1]}
          </button>
        ))}
      </div>
      <div className="curve-body" tabIndex={0} role="region" aria-label="Futures curve">
        {error && !data && <p className="empty muted">{error}</p>}
        {!data && !error && <p className="empty muted">Loading curve…</p>}
        {data && pts.length < 2 && <p className="empty muted">Not enough listed contracts for a curve.</p>}
        {s && (
          <>
            <div className="curve-head">
              <div>
                <span className="muted">Shape</span>
                <strong className={SHAPE_CLASS[s.shape]}>{s.shape}</strong>
                <small className="muted" title="Contango: later months dearer. Backwardation: later months cheaper (tight supply).">
                  {s.shape === "contango" ? "later months dearer" : s.shape === "backwardation" ? "later months cheaper" : "flat"}
                </small>
              </div>
              {s.m1m2 !== undefined && (
                <div title="Second contract minus the front contract">
                  <span className="muted">M1–M2</span>
                  <strong className={s.m1m2 >= 0 ? "up" : "down"}>{signed(s.m1m2)}</strong>
                  {s.rollYieldPct !== undefined && <small className="muted" title="The nearest roll as an annual rate; positive when the front is dearer">roll {s.rollYieldPct > 0 ? "+" : ""}{nf.format(s.rollYieldPct)}% a year</small>}
                </div>
              )}
              {s.m1Last !== undefined && (
                <div title="Last listed contract minus the front contract">
                  <span className="muted">M1–M{pts.length}</span>
                  <strong className={s.m1Last >= 0 ? "up" : "down"}>{signed(s.m1Last)}</strong>
                </div>
              )}
            </div>
            <svg className="curve-chart" viewBox="0 0 600 90" preserveAspectRatio="none" role="img" aria-label="Futures price by delivery month">
              <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Expiry</th>
                  <th>Price</th>
                  <th title="Price minus the previous contract">Spread</th>
                  <th>Volume</th>
                </tr>
              </thead>
              <tbody>
                {pts.map((p) => (
                  <tr key={p.code}>
                    <td>{month(p.expiry)}</td>
                    <td className="muted">{day(p.expiry)}</td>
                    <td>{nf.format(p.price)}</td>
                    <td className={p.spread === undefined ? "muted" : p.spread >= 0 ? "up" : "down"}>{p.spread === undefined ? "—" : signed(p.spread)}</td>
                    <td className="muted">{p.volume === undefined ? "—" : new Intl.NumberFormat(locale).format(p.volume)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted curve-note">Prices from TradingView by dated contract; the first row is the nearest unexpired contract. Thin far months can print stale prices.</p>
          </>
        )}
      </div>
    </div>
  );
}
