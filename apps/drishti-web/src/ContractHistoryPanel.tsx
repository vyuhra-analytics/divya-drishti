import { useEffect, useMemo, useState } from "react";
import { instrument, resampleBars, type Bar } from "@drishti/shared";
import { usePoll } from "./Feeds";
import { apiUrl, makeFormat, useClock, useSettings } from "./settings";
import { useStore } from "./store";
import { useWidgetSymbol, type Widget } from "./workspace";

interface Contract {
  key: string;
  symbol: string;
  expiry: string;
  strike: number;
  side: "CE" | "PE" | "FUT";
  lot?: number | null;
}

const IST_SEC = 19_800;
const TFS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 } as const;
type Tf = keyof typeof TFS;
const SESSIONS = [1, 3, 5, 10] as const;
const SIDE_LABEL: Record<Contract["side"], string> = { FUT: "Future", CE: "Call", PE: "Put" };
const istDay = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);

// the chart's drawing area, in SVG units (the element scales to the panel)
const W = 600;
const H_PRICE = 150;
const H_OI = 50;
const H_VOL = 50;
const GAP = 8;
const H = H_PRICE + H_OI + H_VOL + 2 * GAP;

const line = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");

/**
 * Candle history of one contract from our own recording (the option candle recorder copies every future and option of the four underlyings after
 * each MCX close): price, open interest and volume, for live contracts and for expired ones, which Upstox no longer serves. Research only.
 */
export function ContractHistoryWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const underlying = instrument(symbol)?.upstox;
  const locale = useSettings((s) => s.locale);
  const clock = useClock();
  const spot = useStore((s) => s.quotes[symbol]?.price);
  const contracts = usePoll<Contract[]>(underlying ? `${apiUrl()}/feed/contracts?underlying=${underlying}` : "", 5 * 60_000);
  const [side, setSide] = useState<Contract["side"]>("CE");
  const [expiry, setExpiry] = useState("");
  const [strike, setStrike] = useState<number | null>(null);
  const [tf, setTf] = useState<Tf>("5m");
  const [sessions, setSessions] = useState<(typeof SESSIONS)[number]>(3);
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const all = contracts ?? [];
  const ofSide = useMemo(() => all.filter((c) => c.side === side), [all, side]);
  const expiries = useMemo(() => [...new Set(ofSide.map((c) => c.expiry))].sort(), [ofSide]);
  const strikes = useMemo(() => [...new Set(ofSide.filter((c) => c.expiry === expiry).map((c) => c.strike))].sort((a, b) => a - b), [ofSide, expiry]);

  // sensible defaults: the nearest expiry that is not over, and the strike nearest the money
  useEffect(() => {
    if (!expiries.length) return setExpiry("");
    if (!expiries.includes(expiry)) setExpiry(expiries.find((e) => e >= istDay(Date.now())) ?? expiries[expiries.length - 1]);
  }, [expiries, expiry]);
  useEffect(() => {
    if (side === "FUT") return setStrike(null);
    if (!strikes.length) return setStrike(null);
    if (strike === null || !strikes.includes(strike)) setStrike(spot === undefined ? strikes[Math.floor(strikes.length / 2)] : strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a)));
  }, [strikes, side, spot, strike]);

  const contract = ofSide.find((c) => c.expiry === expiry && (side === "FUT" || c.strike === strike));

  useEffect(() => {
    setBars(null);
    setError(null);
    setHover(null);
    if (!contract) return;
    let alive = true;
    const ctrl = new AbortController();
    const to = istDay(Date.now());
    const from = istDay(Date.now() - 39 * 86_400_000); // the longest window the route allows; the sessions chooser trims it
    fetch(`${apiUrl()}/option-candles?key=${encodeURIComponent(contract.key)}&from=${from}&to=${to}`, { signal: ctrl.signal })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
        if (alive) setBars(json as Bar[]);
      })
      .catch((e: Error) => alive && e.name !== "AbortError" && setError(e.message));
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [contract?.key]);

  /** the last N sessions that have candles, at the chosen resolution */
  const shown = useMemo(() => {
    if (!bars?.length) return [];
    const days = [...new Set(bars.map((b) => istDay(b.time * 1000)))].slice(-sessions);
    const keep = new Set(days);
    return resampleBars(
      bars.filter((b) => keep.has(istDay(b.time * 1000))),
      TFS[tf],
      IST_SEC,
    );
  }, [bars, sessions, tf]);

  const price = makeFormat(locale, 2).price;
  const int = (v: number | undefined) => (v === undefined ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v));

  // x by candle index, not by time: the overnight and weekend gaps would otherwise eat the chart
  const n = shown.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const lo = n ? Math.min(...shown.map((b) => b.low)) : 0;
  const hi = n ? Math.max(...shown.map((b) => b.high)) : 1;
  const yPrice = (v: number) => H_PRICE - ((v - lo) / Math.max(1e-9, hi - lo)) * (H_PRICE - 6) - 3;
  const oiVals = shown.flatMap((b) => (b.oi === undefined ? [] : [b.oi]));
  const oiLo = oiVals.length ? Math.min(...oiVals) : 0;
  const oiHi = oiVals.length ? Math.max(...oiVals) : 1;
  const yOi = (v: number) => H_PRICE + GAP + H_OI - ((v - oiLo) / Math.max(1, oiHi - oiLo)) * (H_OI - 6) - 3;
  const maxVol = Math.max(1, ...shown.map((b) => b.volume));
  const volTop = H_PRICE + H_OI + 2 * GAP;
  const dayStarts = shown.flatMap((b, i) => (i > 0 && istDay(b.time * 1000) !== istDay(shown[i - 1].time * 1000) ? [i] : []));
  const at = hover !== null ? shown[hover] : shown[n - 1];

  return (
    <div className="ch">
      <div className="ch-bar no-drag">
        {(["FUT", "CE", "PE"] as const).map((s) => (
          <button key={s} className="tf" aria-pressed={side === s} onClick={() => setSide(s)}>
            {SIDE_LABEL[s]}
          </button>
        ))}
        <select aria-label="Expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          {expiries.map((e) => (
            <option key={e} value={e}>
              {e}
              {e < istDay(Date.now()) ? " (expired)" : ""}
            </option>
          ))}
        </select>
        {side !== "FUT" && (
          <select aria-label="Strike" value={strike ?? ""} onChange={(e) => setStrike(Number(e.target.value))}>
            {strikes.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
        <select aria-label="Resolution" value={tf} onChange={(e) => setTf(e.target.value as Tf)}>
          {Object.keys(TFS).map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select aria-label="Sessions" value={sessions} onChange={(e) => setSessions(Number(e.target.value) as (typeof SESSIONS)[number])}>
          {SESSIONS.map((d) => (
            <option key={d} value={d}>
              last {d} session{d === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </div>

      {!underlying && <p className="empty muted">Candle history is recorded for the MCX contracts only. Link this panel to a crude or natural gas contract.</p>}
      {underlying && !contracts && <p className="empty muted">Loading contracts…</p>}
      {underlying && contracts && all.length === 0 && <p className="empty muted">Nothing recorded yet for {underlying}. The recorder copies every contract's candles after each MCX close.</p>}
      {error && <p className="down ocx-err">{error}</p>}
      {contract && bars && n === 0 && !error && <p className="empty muted">No candles recorded for {contract.symbol} in the last 40 days.</p>}

      {n > 0 && (
        <>
          <div className="ch-read" aria-live="off">
            <b>{contract?.symbol}</b>
            {at && (
              <>
                <span className="muted">{clock.stamp(at.time * 1000)}</span>
                <span>
                  O {price(at.open)} H {price(at.high)} L {price(at.low)} C {price(at.close)}
                </span>
                <span>Vol {int(at.volume)}</span>
                <span>OI {int(at.oi)}</span>
              </>
            )}
          </div>
          <svg
            className="ch-svg"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${contract?.symbol}: price from ${price(lo)} to ${price(hi)}, ${n} candles`}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / Math.max(1, r.width)) * (n - 1)))));
            }}
            onMouseLeave={() => setHover(null)}
          >
            {dayStarts.map((i) => (
              <line key={i} className="ch-day" x1={x(i)} x2={x(i)} y1={0} y2={H} />
            ))}
            <path className="ch-price" d={line(shown.map((b, i) => [x(i), yPrice(b.close)]))} />
            {oiVals.length > 0 && <path className="ch-oi" d={line(shown.flatMap((b, i) => (b.oi === undefined ? [] : [[x(i), yOi(b.oi)] as [number, number]])))} />}
            {shown.map((b, i) => (
              <rect key={b.time} className="ch-vol" x={x(i) - Math.max(0.4, W / n / 2.4)} width={Math.max(0.8, W / n / 1.2)} y={volTop + H_VOL - (b.volume / maxVol) * H_VOL} height={(b.volume / maxVol) * H_VOL} />
            ))}
            {hover !== null && <line className="ch-cross" x1={x(hover)} x2={x(hover)} y1={0} y2={H} />}
          </svg>
          <div className="ch-legend muted">
            <span>
              <i className="ch-key price" /> Close {price(lo)} to {price(hi)}
            </span>
            <span>
              <i className="ch-key oi" /> Open interest{oiVals.length ? ` ${int(oiLo)} to ${int(oiHi)}` : " (none recorded)"}
            </span>
            <span>
              <i className="ch-key vol" /> Volume
            </span>
            <span>Candles from our own recording; the x axis skips the time the market was closed.</span>
          </div>
        </>
      )}
    </div>
  );
}
