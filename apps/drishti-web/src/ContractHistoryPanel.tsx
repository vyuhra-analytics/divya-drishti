import { useEffect, useMemo, useState } from "react";
import { instrument, resampleBars, type Bar, type FlowBucket } from "@drishti/shared";
import { usePoll } from "./Feeds";
import { apiUrl, makeFormat, useClock, useSettings } from "./settings";
import { useStore } from "./store";
import { useWidgetSymbol, type Widget } from "./workspace";
import { Button, Select } from "./ui";

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
const H_DELTA = 50;
const H_IMB = 36;
const GAP = 8;
const H = H_PRICE + H_OI + H_VOL + H_DELTA + H_IMB + 4 * GAP;
/** order flow is estimated from the tick-level recording, which holds a window of at most this long per request (the route allows two days) */
const FLOW_WINDOW_MS = 47 * 3600_000;

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
  const [flow, setFlow] = useState<FlowBucket[] | null>(null);

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

  // estimated order flow for the same candles, from our own recording of the feed (only the contracts the stream records tick by tick have any)
  const flowKey = contract && shown.length ? `${contract.key}|${tf}|${shown[0].time}|${shown[shown.length - 1].time}` : "";
  useEffect(() => {
    setFlow(null);
    if (!flowKey || !contract) return;
    let alive = true;
    const ctrl = new AbortController();
    const to = (shown[shown.length - 1].time + TFS[tf]) * 1000;
    const from = Math.max(shown[0].time * 1000, to - FLOW_WINDOW_MS);
    fetch(`${apiUrl()}/feed/flow?key=${encodeURIComponent(contract.key)}&from=${from}&to=${to}&tf=${tf}`, { signal: ctrl.signal })
      .then(async (res) => (res.ok ? ((await res.json()) as { buckets: FlowBucket[] }).buckets : []))
      .then((b) => alive && setFlow(b))
      .catch(() => alive && setFlow([]));
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [flowKey]);
  const flowAt = useMemo(() => new Map((flow ?? []).map((f) => [f.time, f])), [flow]);

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
  const deltaTop = volTop + H_VOL + GAP;
  const imbTop = deltaTop + H_DELTA + GAP;
  const maxDelta = Math.max(1, ...shown.map((b) => Math.abs(flowAt.get(b.time)?.delta ?? 0)));
  const hasFlow = shown.some((b) => flowAt.has(b.time));
  const yImb = (v: number) => imbTop + H_IMB / 2 - (v * (H_IMB - 6)) / 2;
  const dayStarts = shown.flatMap((b, i) => (i > 0 && istDay(b.time * 1000) !== istDay(shown[i - 1].time * 1000) ? [i] : []));
  const at = hover !== null ? shown[hover] : shown[n - 1];
  const fat = at ? flowAt.get(at.time) : undefined;
  const signed = (v: number) => `${v > 0 ? "+" : ""}${int(v)}`;

  return (
    <div className="ch">
      <div className="ch-bar no-drag">
        {(["FUT", "CE", "PE"] as const).map((s) => (
          <Button key={s} size="sm" aria-pressed={side === s} onClick={() => setSide(s)}>
            {SIDE_LABEL[s]}
          </Button>
        ))}
        <Select aria-label="Expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          {expiries.map((e) => (
            <option key={e} value={e}>
              {e}
              {e < istDay(Date.now()) ? " (expired)" : ""}
            </option>
          ))}
        </Select>
        {side !== "FUT" && (
          <Select aria-label="Strike" value={strike ?? ""} onChange={(e) => setStrike(Number(e.target.value))}>
            {strikes.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        )}
        <Select aria-label="Resolution" value={tf} onChange={(e) => setTf(e.target.value as Tf)}>
          {Object.keys(TFS).map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
        <Select aria-label="Sessions" value={sessions} onChange={(e) => setSessions(Number(e.target.value) as (typeof SESSIONS)[number])}>
          {SESSIONS.map((d) => (
            <option key={d} value={d}>
              last {d} session{d === 1 ? "" : "s"}
            </option>
          ))}
        </Select>
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
                {fat && (
                  <span title="Estimated from our recording of the feed: not an exchange figure">
                    Δ {signed(fat.delta)} (est.) · book {fat.imbalance === undefined ? "—" : `${fat.imbalance > 0 ? "+" : ""}${fat.imbalance.toFixed(2)}`} · spread {fat.spread === undefined ? "—" : price(fat.spread)}
                  </span>
                )}
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
 {hasFlow && (
              <>
                <line className="ch-zero" x1={0} x2={W} y1={deltaTop + H_DELTA / 2} y2={deltaTop + H_DELTA / 2} />
                {shown.map((b, i) => {
                  const f = flowAt.get(b.time);
                  if (!f || f.delta === 0) return null;
                  const h = (Math.abs(f.delta) / maxDelta) * (H_DELTA / 2);
                  return <rect key={b.time} className={f.delta > 0 ? "ch-dpos" : "ch-dneg"} x={x(i) - Math.max(0.4, W / n / 2.4)} width={Math.max(0.8, W / n / 1.2)} y={f.delta > 0 ? deltaTop + H_DELTA / 2 - h : deltaTop + H_DELTA / 2} height={h} />;
                })}
                <line className="ch-zero" x1={0} x2={W} y1={imbTop + H_IMB / 2} y2={imbTop + H_IMB / 2} />
                <path
                  className="ch-imb"
                  d={line(shown.flatMap((b, i) => { const v = flowAt.get(b.time)?.imbalance; return v === undefined ? [] : [[x(i), yImb(v)] as [number, number]]; }))}
                />
              </>
            )}
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
            {hasFlow && (
              <span>
                <i className="ch-key delta" /> Delta (estimated buy minus sell volume) · <i className="ch-key imb" /> Book imbalance (bid minus ask size, -1 to +1)
              </span>
            )}
            {flow !== null && !hasFlow && <span>No order flow for this contract: only the futures and the options near the money are recorded tick by tick, and only since 26 Oct.</span>}
            <span>Candles from our own recording; the x axis skips the time the market was closed.</span>
            {hasFlow && <span>Delta and book are estimates from about one snapshot a second: right on average, least accurate when trading is fastest. Not an exchange figure.</span>}
          </div>
        </>
      )}
    </div>
  );
}
