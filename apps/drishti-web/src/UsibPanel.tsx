import { useEffect, useMemo, useRef, useState } from "react";
import { chainLevels, DAY_RULES, suggestStrike, usibRange, usibStage, usOpenFor, USIB_RULES, watchUsib, type UsibBar, type UsibStage } from "@drishti/shared";
import { apiUrl, useClock } from "./settings";
import { useChain } from "./chainClient";
import { useAlerts } from "./alertsStore";
import { notify } from "./alertEngine";
import { ReportDayTrade } from "./ReportDayTrade";
import { StrikeBlock } from "./StrikeBlock";
import { usePublishLevels } from "./strategyLevels";
import { loadRecord } from "./reportDayStore";
import { useNow } from "./market";
import { useStore } from "./store";
import type { Widget } from "./workspace";
import { Button } from "./ui";

// USIB, the non-report-day strategy (docs/redesign/USER_AND_JOBS.md; logic in shared usib.ts): the range of the hour before the US cash open, each 5-minute
// candle after it with its volume against the ten before and its side of session VWAP, the one signal a day, the entry, R, stop, TP1, TP2 (a chain level) and
// the trail, the option to buy, and the same hand-entered trade follow-up and review as the report day. The owner parked this strategy with rule questions open:
// the answers used here are named defaults in USIB_RULES. Nothing here places an order.

const NAMES = { CRUDEOIL: "Crude", NATGASMINI: "Gas (mini)" } as const;
type Underlying = keyof typeof NAMES;
const STAGE_NAME: Record<UsibStage, string> = { wait: "Waiting", range: "Range", watch: "Entry window", after: "Entry window closed" };
const num = (v: number | undefined, dp = 1) => (v === undefined ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const rs = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function UsibWidget(_: { widget: Widget }) {
  const now = useNow(1000);
  const clock = useClock();
  const [underlying, setUnderlying] = useState<Underlying>("CRUDEOIL");
  const symbol = `MCX:${underlying}`;
  const [bars, setBars] = useState<UsibBar[]>([]);
  const [reportDay, setReportDay] = useState<string | undefined>(undefined);

  const openAt = useMemo(() => usOpenFor(now), [Math.floor(now / 60_000)]);
  const openSec = Math.round(openAt / 1000);
  const nowSec = Math.floor(now / 1000);
  const stage = usibStage(now, openAt);
  const active = stage === "range" || stage === "watch";

  // is an EIA report scheduled on the day of this open? Then the report-day strategy is the day's trade, not this one
  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      const day = 86_400_000;
      const q = `from=${new Date(openAt - day).toISOString().slice(0, 10)}&to=${new Date(openAt + 2 * day).toISOString().slice(0, 10)}`;
      try {
        const all = (await Promise.all((["WPSR", "WNGSR"] as const).map((s) => fetch(`${apiUrl()}/calendar/stored?${q}&series=${s}`, { signal: ctrl.signal }).then((r) => (r.ok ? r.json() : []))))).flat() as { series_code: string; scheduled_at: string }[];
        const ny = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(t);
        const hit = all.find((e) => ny(Date.parse(e.scheduled_at)) === ny(openAt));
        setReportDay(hit ? (hit.series_code === "WPSR" ? "petroleum" : "natural gas") : undefined);
      } catch {
        /* the next poll tries again */
      }
    };
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [openAt]);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(symbol)}&tf=5m`, { signal: ctrl.signal });
        if (res.ok) setBars(((await res.json()) as UsibBar[]).map((b) => ({ ...b, volume: Number(b.volume ?? 0) })));
      } catch {
        /* the next poll tries again */
      }
    };
    setBars([]);
    void load();
    const id = setInterval(load, active ? 10_000 : 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [symbol, active]);

  // crude options: the nearest expiry; NATGASMINI options: the next one (owner decision)
  const [expiry, setExpiry] = useState("");
  const { chain } = useChain(underlying, expiry, "auto", 8, stage !== "after");
  useEffect(() => setExpiry(""), [underlying]);
  useEffect(() => {
    if (underlying === "NATGASMINI" && expiry === "" && chain && chain.expiries.length > 1 && chain.expiry === chain.expiries[0]) setExpiry(chain.expiries[1]);
  }, [underlying, expiry, chain?.expiry, chain?.expiries.length]);

  const levels = useMemo(() => chainLevels(chain), [chain]);
  const range = useMemo(() => usibRange(bars, openSec, nowSec), [bars, openSec, Math.floor(now / 5000)]);
  const watch = useMemo(() => (range && nowSec >= openSec ? watchUsib(bars, openSec, range, levels, nowSec) : undefined), [bars, range, levels, openSec, Math.floor(now / 5000)]);
  const signal = watch?.signal;
  const strike = useMemo(() => suggestStrike(chain, signal?.side, signal?.rPoints), [chain, signal?.side, signal?.rPoints]);
  const livePrice = useStore((s) => s.quotes[symbol]?.price);

  // the range and the signal's levels on the chart (the trade's own levels are published by the trade block)
  const tradingNow = !!loadRecord(`usib:${openAt}`).trade;
  usePublishLevels("usib:range", range ? [{ price: range.high, title: "USIB range high", color: "#42a5f5", style: "solid" }, { price: range.low, title: "USIB range low", color: "#42a5f5", style: "solid" }] : []);
  usePublishLevels(
    "usib:signal",
    signal && !tradingNow ? [
      { price: signal.entry ?? NaN, title: "Entry (next open)", color: "#e0e0e0" },
      { price: signal.stop ?? NaN, title: "Stop 1R", color: "#ef5350" },
      { price: signal.tp1 ?? NaN, title: "TP1 +1R", color: "#66bb6a" },
      { price: signal.tp2 ?? NaN, title: "TP2 (chain level)", color: "#43a047" },
    ] : [],
  );

  // announcements, once each per day and only while live
  const announced = useRef<Set<string>>(new Set());
  const say = (key: string, message: string) => {
    const k = `${openAt}:${underlying}:${key}`;
    if (announced.current.has(k)) return;
    announced.current.add(k);
    useAlerts.getState().push("usib", message);
    notify(message);
  };
  const minsToCutoff = Math.ceil((openAt + USIB_RULES.entryWindowMin * 60_000 - now) / 60_000);
  useEffect(() => {
    if (stage === "watch" && signal && !reportDay) say("signal", `USIB: SIGNAL ${signal.side.toUpperCase()} after the ${clock.time(signal.candleTime * 1000)} candle: volume and VWAP agree`);
  }, [stage, signal?.side, signal?.candleTime, reportDay]);
  useEffect(() => {
    if (stage === "watch" && !signal && minsToCutoff === 5 && !reportDay) say("cutoff", "USIB: 5 minutes left in the entry window");
  }, [stage, signal?.side, minsToCutoff, reportDay]);

  const lastCandle = bars.length ? Math.max(...bars.map((b) => b.time)) : undefined;
  const candleAge = lastCandle === undefined ? undefined : now - lastCandle * 1000;
  const pricedStrikes = chain ? chain.rows.filter((r) => ((r.ce?.ask && r.ce.ask > 0) || (r.ce?.ltp && r.ce.ltp > 0)) && r.ce?.delta !== undefined).length : 0;
  const ready = [
    { id: "day", label: "A USIB day", ok: !reportDay, detail: reportDay ? `an EIA ${reportDay} report is scheduled today: the report-day strategy is the trade (F7)` : "no EIA report today" },
    { id: "candles", label: "5-minute candles", ok: candleAge !== undefined && candleAge < 12 * 60_000, detail: candleAge === undefined ? "none loaded" : candleAge < 12 * 60_000 ? "current" : `the newest opened ${Math.round(candleAge / 60_000)} minutes ago (is MCX open?)` },
    { id: "volume", label: "Volume in the candles", ok: bars.slice(-10).some((b) => b.volume > 0), detail: bars.slice(-10).some((b) => b.volume > 0) ? "present" : "none: the 1.5x volume filter cannot be read" },
    { id: "chain", label: "Option chain", ok: chain !== null && chain !== undefined && now - chain.updatedAt < 20_000 && pricedStrikes >= 3, detail: !chain ? "not loaded" : pricedStrikes < 3 ? "too few strikes with a price and a delta" : `${pricedStrikes} strikes with prices and greeks` },
  ];

  const trading = !!loadRecord(`usib:${openAt}`).trade; // in trade or done: the trade block leads
  const strip =
    stage === "wait" ? `Range hour starts in ${countdown(openAt - USIB_RULES.rangeMin * 60_000 - now)}` : stage === "range" ? `Range hour: the US opens in ${countdown(openAt - now)}` : stage === "watch" ? `New signals until ${clock.time(openAt + USIB_RULES.entryWindowMin * 60_000)} (${countdown(openAt + USIB_RULES.entryWindowMin * 60_000 - now)})` : "No new signals";

  return (
    <div className="rd" role="region" aria-label="USIB">
      <div className={`rd-strip rd-${stage === "watch" ? "window" : stage === "after" ? "after" : stage}`}>
        <b>{STAGE_NAME[stage]}</b>
        <span>{strip}</span>
        <small className="muted">
          US open {clock.time(openAt)} · {new Date(openAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })} New York
        </small>
      </div>

      <div className="toolbar no-drag" role="group" aria-label="Contract">
        {(Object.keys(NAMES) as Underlying[]).map((u) => (
          <Button key={u} variant={u === underlying ? "default" : "ghost"} size="sm" onClick={() => setUnderlying(u)}>
            {NAMES[u]}
          </Button>
        ))}
        <span className="muted rd-note">non-report days</span>
      </div>

      {reportDay && (
        <p className="rd-flash down" role="note">
          An EIA {reportDay} report is scheduled today: the report-day strategy is the day's trade. Open the Report day desk (F7).
        </p>
      )}

      <ReportDayTrade
        releaseAt={openAt}
        recordKey={`usib:${openAt}`}
        timeStop={{ fromMin: USIB_RULES.timeStopFromMin, toMin: USIB_RULES.timeStopToMin }}
        symbol={symbol}
        signal={signal ? { side: signal.side, candleTime: signal.candleTime, entry: signal.entry, rPoints: signal.rPoints, tp2: signal.tp2, trail: signal.trail } : undefined}
        pick={strike.pick}
        units={chain?.lot ?? 1}
        bars={bars}
        now={now}
        chainBid={(k, sd) => chain?.rows.find((r) => r.strike === k)?.[sd === "long" ? "ce" : "pe"]?.bid}
        onEvent={(m) => say(`trade:${m}`, m)}
      />

      {(stage === "wait" || stage === "range") && (
        <section aria-label="Ready for the open">
          <h2>Ready for the open?</h2>
          <ul className="rd-ready">
            {ready.map((x) => (
              <li key={x.id} className={x.ok ? "up" : "down"}>
                <b>{x.ok ? "✓" : "✗"}</b> {x.label} <span className="muted">· {x.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Range: the hour before the US open</h2>
        {range ? (
          <>
            <p className="rd-rangebox">
              <b>{num(range.high, 1)}</b> high · <b>{num(range.low, 1)}</b> low · width <b>{num(range.width, 1)}</b> <small className="muted">({range.candles} candles{range.complete ? "" : ", still building"})</small>
            </p>
            {livePrice !== undefined && (
              <p className="muted rd-live">
                Price {num(livePrice, 1)}: {livePrice > range.high ? `${num(livePrice - range.high, 1)} above the range` : livePrice < range.low ? `${num(range.low - livePrice, 1)} below the range` : `inside, ${num(range.high - livePrice, 1)} under the high and ${num(livePrice - range.low, 1)} over the low`}
                {stage === "watch" && ` · the candle closes in ${countdown((Math.floor(nowSec / DAY_RULES.candleSec) + 1) * DAY_RULES.candleSec * 1000 - now)}`}
              </p>
            )}
          </>
        ) : (
          <p className="muted">The range starts at {clock.time(openAt - USIB_RULES.rangeMin * 60_000)}.</p>
        )}
      </section>

      {watch && range && (
        <section>
          <h2>Each 5-minute candle after the open</h2>
          {trading ? null : watch.candles.length === 0 ? (
            <p className="muted">The first candle closes at {clock.time(openAt + DAY_RULES.candleSec * 1000)}.</p>
          ) : (
            <table className="bt-num rd-table">
              <thead>
                <tr>
                  <th>Candle</th>
                  <th>Close</th>
                  <th>Range</th>
                  <th title="Volume against the average of the ten candles before it; 1.5x needed">Volume</th>
                  <th title="The close against session VWAP">VWAP</th>
                </tr>
              </thead>
              <tbody>
                {watch.candles.map((c) => (
                  <tr key={c.time} className={!c.complete ? "muted" : signal?.candleTime === c.time ? "next" : ""} title={c.filtered}>
                    <td>{clock.time(c.time * 1000)}</td>
                    <td>{num(c.close, 1)}</td>
                    <td className={c.state === "above" ? "up" : c.state === "below" ? "down" : ""}>
                      {c.state === "inside" ? "inside" : c.state === "above" ? "above" : "below"}
                      {!c.complete && " (forming)"}
                    </td>
                    <td className={c.state === "inside" ? "muted" : c.volumeOk ? "up" : "down"}>{c.volumeRatio === undefined ? "—" : `${num(c.volumeRatio, 1)}x`}</td>
                    <td className={c.state === "inside" ? "muted" : c.vwapOk ? "up" : "down"}>{c.vwap === undefined ? "—" : num(c.vwap, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {watch.candles.filter((c) => c.filtered).map((c) => (
            <p key={c.time} className="muted">
              {clock.time(c.time * 1000)} closed {c.state} the range but was filtered: {c.filtered}.
            </p>
          ))}
          {signal ? (
            <div className={`rd-signal ${signal.side === "long" ? "up" : "down"}`}>
              <b>SIGNAL: {signal.side.toUpperCase()}</b> after the {clock.time(signal.candleTime * 1000)} candle: closed {signal.side === "long" ? "above" : "below"} the range, volume {num(watch.candles.find((c) => c.time === signal.candleTime)?.volumeRatio, 1)}x, {signal.side === "long" ? "above" : "below"} VWAP.
              {signal.entry === undefined ? (
                <div>Entry reference: the next candle's open (not open yet).</div>
              ) : (
                <div>
                  Entry reference <b>{num(signal.entry, 1)}</b> · R <b>{num(signal.rPoints, 1)}</b> points (1.5 × ATR {num(signal.atr, 1)}) · stop <b>{num(signal.stop, 1)}</b> · TP1 <b>{num(signal.tp1, 1)}</b> (then the stop to entry) · TP2 <b>{num(signal.tp2, 1)}</b> ({signal.tp2Source}) · then the stop trails <b>{num(signal.trail, 1)}</b> under the best close
                </div>
              )}
            </div>
          ) : (
            <p className="muted">{watch.cutoffReached ? "No signal today: the entry window closed." : "No signal yet: a close beyond the range with 1.5x the volume and the right side of VWAP."}</p>
          )}
        </section>
      )}

      {!trading && <StrikeBlock strike={strike} chain={chain} side={signal?.side} price={livePrice} />}
      {!trading && levels.length > 0 && (
        <p className="muted">
          Chain levels for TP2: {levels.filter((l) => l.label !== "round strike").map((l) => `${l.price} (${l.label})`).slice(0, 6).join(" · ") || "round strikes only"}
        </p>
      )}

      <p className="muted rd-foot">
        Rules (owner): the range is the hour before the US open; a 5-minute close beyond it with volume at least 1.5× the previous ten candles and on the right side of session VWAP is the signal; one signal a day; entry at the next candle's open; R = 1.5 × ATR(14); stop 1R by touch; TP1 +1R then the stop to entry; TP2 the next chain level at least 0.5R beyond TP1, else 2R; then the stop trails 1 ATR under the best close; time stop {USIB_RULES.timeStopFromMin} to {USIB_RULES.timeStopToMin} minutes after the open. Defaults I chose where the owner had not said (change in `USIB_RULES`): the range follows the US open after the clock change, signals for {USIB_RULES.entryWindowMin} minutes after the open, VWAP anchored at the 09:00 IST day open, the trail starting at TP2. No order is placed here: you enter and manage the trade by hand.
      </p>
    </div>
  );
}
