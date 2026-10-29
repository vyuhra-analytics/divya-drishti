import { useEffect, useMemo, useRef, useState } from "react";
import { DAY_RULES, dayStage, preReleaseRange, readiness, optionLegFor, REPORT_DAY, reportSignal, suggestStrike, tradingExpiry, watchWindow, type DayBar, type DayStage, type ReportCode } from "@drishti/shared";
import { apiUrl, useClock } from "./settings";
import { useChain } from "./chainClient";
import { useAlerts } from "./alertsStore";
import { notify } from "./alertEngine";
import { AutoPaper } from "./AutoPaper";
import { ReportDayTrade } from "./ReportDayTrade";
import { StrikeBlock } from "./StrikeBlock";
import { usePublishLevels } from "./strategyLevels";
import { loadRecord, saveRecord } from "./reportDayStore";
import { useStore } from "./store";
import { useNow } from "./market";
import type { Widget } from "./workspace";
import { Button, Input } from "./ui";

// The EIA report-day screen, stages prep, range, print and window (docs/redesign/EIA_SCREENS.md and EIA_STRATEGY.md). One column that changes with the
// time: the forecast and threshold before the print, the live range of the last hour, the number and its surprise the second it is stored, then each
// 5-minute candle after it (inside / closed above / closed below) with the entry, R and levels when a close gives one, and the option strike to buy.
// Nothing here places an order: the trade is entered and managed by hand.

interface StoredEvent {
  id: string;
  series_code: ReportCode;
  scheduled_at: string;
  status: string;
  observations: { kind: string; num: number | null; source: string; observedAt: string }[];
}

interface Release {
  report: ReportCode;
  at: number;
  /** the newest forecast recorded for this release and where it came from */
  forecast?: { value: number; source: string; at: number };
  /** every figure recorded for it, newest first, one per change (a source that repeats the same figure is listed once) */
  forecasts?: { value: number; source: string; at: number }[];
}

/** The forecast figures of a release, newest first, a repeat of the figure the same source gave before left out. */
export function forecastHistory(obs: { kind: string; num: number | null; source: string; observedAt: string }[]): { value: number; source: string; at: number }[] {
  const all = obs
    .filter((o) => o.kind === "forecast" && o.num !== null)
    .map((o) => ({ value: Number(o.num), source: o.source, at: Date.parse(o.observedAt) }))
    .filter((o) => Number.isFinite(o.at))
    .sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  return all.filter((o) => {
    const k = `${o.source}|${o.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const STAGE_NAME: Record<DayStage, string> = { prep: "Prep", range: "Range", print: "Print", window: "Window", after: "Entry window closed" };
const num = (v: number | undefined, dp = 1) => (v === undefined ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const signed = (v: number | undefined, dp = 1) => (v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "-" : ""}${num(Math.abs(v), dp)}`);
const rs = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** The release to show: the one that came out in the last 3 hours, else the next one. */
function pickRelease(events: StoredEvent[], now: number, force?: ReportCode): Release | undefined {
  const list = events
    .filter((e) => !force || e.series_code === force)
    .map((e) => ({ e, at: Date.parse(e.scheduled_at) }))
    .filter((x) => Number.isFinite(x.at));
  const recent = list.filter((x) => x.at <= now && now - x.at < 3 * 3600_000).sort((a, b) => b.at - a.at)[0];
  const next = list.filter((x) => x.at > now).sort((a, b) => a.at - b.at)[0];
  const x = recent ?? next;
  if (!x) return undefined;
  const forecasts = forecastHistory(x.e.observations);
  return { report: x.e.series_code, at: x.at, forecast: forecasts[0], forecasts };
}

export function ReportDayWidget(_: { widget: Widget }) {
  const now = useNow(1000);
  const clock = useClock();
  const [force, setForce] = useState<ReportCode | undefined>(undefined);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [typed, setTyped] = useState("");
  const [consensus, setConsensus] = useState<{ value: number; source: string } | undefined>(undefined);
  /** when the Investing.com reader is paused after a block (epoch ms), so a missing consensus is explained */
  const [consensusPaused, setConsensusPaused] = useState<number | undefined>(undefined);
  const [print, setPrint] = useState<{ change: number; unit: string; officialAt?: number } | undefined>(undefined);
  const [bars, setBars] = useState<DayBar[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reachable, setReachable] = useState<boolean | undefined>(undefined);
  const [recordTick, setRecordTick] = useState(0);

  // the stored releases of both reports around today, once a minute
  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      const day = 86_400_000;
      const q = `from=${new Date(Date.now() - day).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 9 * day).toISOString().slice(0, 10)}`;
      try {
        const all = await Promise.all((["WPSR", "WNGSR"] as const).map((s) => fetch(`${apiUrl()}/calendar/stored?${q}&series=${s}`, { signal: ctrl.signal }).then((r) => (r.ok ? r.json() : []))));
        setEvents(all.flat() as StoredEvent[]);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, []);

  const release = useMemo(() => pickRelease(events, now, force), [events, Math.floor(now / 60_000), force]);
  const report = release?.report ?? force ?? "WPSR";
  const cfg = REPORT_DAY[report];
  const stage: DayStage | undefined = release ? dayStage(now, release.at) : undefined;
  const releaseSec = release ? Math.round(release.at / 1000) : 0;
  const nowSec = Math.floor(now / 1000);

  // Investing.com's consensus for the next release, when no feed recorded a forecast
  useEffect(() => {
    if (!release) return;
    const ctrl = new AbortController();
    fetch(`${apiUrl()}/eia-report/forecasts?weeks=1${report === "WNGSR" ? "&report=WNGSR" : ""}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => {
        const row = (t?.releases ?? []).find((x: { releaseAt: number }) => Math.abs(x.releaseAt - release.at) < 20 * 3600_000);
        const v = report === "WNGSR" ? row?.storage?.forecast : row?.crude?.forecast;
        setConsensus(typeof v === "number" ? { value: v, source: "Investing.com consensus" } : undefined);
      })
      .catch(() => undefined);
    fetch(`${apiUrl()}/eia-report/forecasts/status`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setConsensusPaused(typeof s?.blockedUntil === "number" && s.blockedUntil > Date.now() ? s.blockedUntil : undefined))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [release?.at, report]);

  // the forecast typed for a release is remembered for it
  useEffect(() => setTyped(release ? (loadRecord(release.at).forecast ?? "") : ""), [release?.at]);
  const typedValue = typed.trim() !== "" && Number.isFinite(Number(typed)) ? Number(typed) : undefined;
  const forecast = typedValue !== undefined ? { value: typedValue, source: "typed in" } : (release?.forecast ?? consensus);
  /** when the forecast on show was recorded: only a figure a feed recorded has a time (a typed one and the consensus have none) */
  const forecastAt = typedValue === undefined ? release?.forecast?.at : undefined;

  // the number: the stored report of THIS release, looked at every 3 s from the print and once a minute otherwise
  const fast = stage === "print" || stage === "window";
  useEffect(() => {
    if (!release) return;
    const ctrl = new AbortController();
    setPrint(undefined);
    const load = async () => {
      try {
        const res = await fetch(`${apiUrl()}/eia-report?report=${report}${forecast ? `&forecast=${forecast.value}` : ""}`, { signal: ctrl.signal });
        setReachable(true);
        if (!res.ok) return;
        const j = await res.json();
        const at: number | undefined = j.officialReleaseAt ?? j.scheduledAt;
        // it is this release's report only when it was published around the scheduled time, not last week's
        if (at !== undefined && Math.abs(at - release.at) < 40 * 60_000 && j.analysis?.headline) setPrint({ change: j.analysis.headline.change, unit: j.analysis.headline.unit, officialAt: j.officialReleaseAt });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setReachable(false);
      }
    };
    void load();
    const id = setInterval(load, fast ? 3000 : 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [release?.at, report, fast, forecast?.value]);

  // the future's 5-minute candles
  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(cfg.symbol)}&tf=5m`, { signal: ctrl.signal });
        if (res.ok) setBars((await res.json()) as DayBar[]);
      } catch {
        /* the next poll tries again */
      }
    };
    void load();
    const id = setInterval(load, stage === "range" || stage === "print" || stage === "window" ? 10_000 : 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [cfg.symbol, stage === "range" || stage === "print" || stage === "window"]);

  // crude options: the nearest expiry; NATGASMINI options: the NEXT one (the nearest expires the day after the report: owner decision, USER_AND_JOBS.md)
  const [expiry, setExpiry] = useState("");
  const { chain } = useChain(cfg.underlying, expiry, "auto", 6, stage !== undefined && stage !== "after");
  useEffect(() => setExpiry(""), [report]);
  useEffect(() => {
    // the nearest expiry, unless it is within 3 days of expiring (then the next): the same for crude and gas
    const want = chain && expiry === "" ? tradingExpiry(chain.expiries, Date.now()) : undefined;
    if (want && want !== chain!.expiry) setExpiry(want);
  }, [report, expiry, chain?.expiry, chain?.expiries.length]);

  const surprise = print && forecast ? print.change - forecast.value : undefined;
  const side = reportSignal(surprise, cfg.threshold);
  const range = useMemo(() => (release ? preReleaseRange(bars, releaseSec, nowSec) : undefined), [bars, releaseSec, Math.floor(now / 5000)]);
  const watch = useMemo(() => (release && range && nowSec >= releaseSec ? watchWindow(bars, releaseSec, range, side, nowSec) : undefined), [bars, range, side, releaseSec, Math.floor(now / 5000)]);
  const signal = watch?.signal;
  const strike = useMemo(() => suggestStrike(chain, signal?.side ?? side, signal?.rPoints), [chain, signal?.side, signal?.rPoints, side]);
  // the option the signal buys, with its premium levels from the future's R and the delta now (the auto paper trade places it)
  const optionLeg = useMemo(() => (signal ? optionLegFor({ side: signal.side, entry: signal.entry, rPoints: signal.rPoints, tp2: signal.tp2 }, chain, cfg.underlying) : undefined), [chain, signal?.side, signal?.candleTime, signal?.entry, signal?.rPoints, signal?.tp2, cfg.underlying]);

  // the range and the signal's levels on the chart (the trade's own levels are published by the trade block)
  const tradingNow = release ? !!loadRecord(release.at).trade : false;
  const rangeFrom = releaseSec - DAY_RULES.rangeMin * 60;
  usePublishLevels("reportday:range", range ? [{ price: range.high, title: "Range high", color: "#42a5f5", style: "solid", from: rangeFrom }, { price: range.low, title: "Range low", color: "#42a5f5", style: "solid", from: rangeFrom }] : []);
  usePublishLevels(
    "reportday:signal",
    signal && !tradingNow ? [
      { price: signal.entry ?? NaN, title: "Entry (next open)", color: "#e0e0e0" },
      { price: signal.stop ?? NaN, title: "Stop 1R", color: "#ef5350" },
      { price: signal.tp1 ?? NaN, title: "TP1 +1R", color: "#66bb6a" },
      { price: signal.tp2 ?? NaN, title: "TP2 +2R", color: "#43a047" },
    ] : [],
  );

  // announcements: a toast, a beep and a desktop notice, once each per release, and only while it is live (never for a print that came out hours ago)
  const announced = useRef<Set<string>>(new Set());
  const say = (key: string, message: string) => {
    const k = `${release?.at}:${key}`;
    if (announced.current.has(k)) return;
    announced.current.add(k);
    useAlerts.getState().push("report-day", message);
    notify(message);
  };
  const live = stage === "print" || stage === "window";
  const minsToCutoff = release ? Math.ceil((release.at + DAY_RULES.cutoffMin * 60_000 - now) / 60_000) : undefined;
  useEffect(() => {
    if (live && print && surprise !== undefined) say("print", `Report day: the number is out, ${signed(print.change, report === "WPSR" ? 3 : 0)} ${cfg.unit}, surprise ${signed(surprise, 2)}: ${side === "long" ? "allows a LONG" : side === "short" ? "allows a SHORT" : "no side from the number"}`);
  }, [live, print?.change, surprise]);
  useEffect(() => {
    if (live && signal) say("signal", `Report day: SIGNAL ${signal.side.toUpperCase()} after the ${clock.time(signal.candleTime * 1000)} candle closed ${signal.side === "long" ? "above" : "below"} the range`);
  }, [live, signal?.side, signal?.candleTime]);
  useEffect(() => {
    if (stage === "window" && !signal && minsToCutoff === 5) say("cutoff", "Report day: 5 minutes left for a new entry");
  }, [stage, signal?.side, minsToCutoff]);
  const lastCandle = bars.length ? Math.max(...bars.map((b) => b.time)) : undefined;
  const pricedStrikes = chain ? chain.rows.filter((r) => ((r.ce?.ask && r.ce.ask > 0) || (r.ce?.ltp && r.ce.ltp > 0)) && r.ce?.delta !== undefined).length : 0;
  const ready = readiness({ now, releaseAt: release?.at, forecast: forecast ? { source: forecast.source } : undefined, lastCandle, chainAgeMs: chain ? now - chain.updatedAt : undefined, chainPriced: pricedStrikes, reportReachable: reachable });
  const livePrice = useStore((s) => s.quotes[cfg.symbol]?.price);

  if (!release || !stage) return <p className="empty muted">{error ?? "No EIA release is scheduled in the next days."}</p>;

  const untilPrint = release.at - now;
  const untilCutoff = release.at + DAY_RULES.cutoffMin * 60_000 - now;
  // the trader's own stages follow the clock's: once they say they entered, the strip says "In trade", and "Done" after the exit
  const rec = loadRecord(release.at);
  const phase = rec.closed ? "Done" : rec.trade ? "In trade" : STAGE_NAME[stage];
  const trading = !!rec.trade; // in trade or done: the trade block leads and the rest folds to what still matters
  const strip =
    rec.closed ? "Review below; no new entries today" : rec.trade ? `Following your ${rec.trade.side} · time stop from ${clock.time(release.at + 90 * 60_000)}` :
    stage === "prep" ? `Print in ${countdown(untilPrint)}` : stage === "range" ? `Range hour: print in ${countdown(untilPrint)}` : stage === "print" ? "The number is out" : stage === "window" ? `New entries until ${clock.time(release.at + DAY_RULES.cutoffMin * 60_000)} (${countdown(untilCutoff)})` : "No new entries";

  return (
    <div className="rd" role="region" aria-label="EIA report day">
      <div className={`rd-strip rd-${stage}`}>
        <b>{phase}</b>
        <span>{strip}</span>
        <small className="muted">
          {report === "WPSR" ? "Petroleum" : "Natural gas"} report · {clock.stamp(release.at)} · {new Date(release.at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })} New York
        </small>
      </div>

      <div className="toolbar no-drag" role="group" aria-label="Report">
        {(["WPSR", "WNGSR"] as const).map((r) => (
          <Button key={r} variant={r === report ? "default" : "ghost"} size="sm" onClick={() => setForce(r)}>
            {r === "WPSR" ? "Crude (WPSR)" : "Gas (WNGSR)"}
          </Button>
        ))}
        <span className="muted rd-note">trades {cfg.underlying} options</span>
      </div>

      <AutoPaper
        strategy="report-day"
        recordKey={String(release.at)}
        releaseAt={release.at}
        signal={signal ? { side: signal.side, candleTime: signal.candleTime } : undefined}
        option={optionLeg?.leg}
        optionReason={optionLeg?.reason}
        onEvent={(m) => say(`auto:${m}`, m)}
      />

      <ReportDayTrade
        releaseAt={release.at}
        symbol={cfg.symbol}
        signal={signal}
        pick={strike.pick}
        units={chain?.lot ?? 1}
        bars={bars}
        now={now}
        chainBid={(k, sd) => chain?.rows.find((r) => r.strike === k)?.[sd === "long" ? "ce" : "pe"]?.bid}
        onEvent={(m) => say(`trade:${m}`, m)}
      />

      {(stage === "prep" || stage === "range") && (
        <section aria-label="Ready for the print">
          <h2>Ready for the print?</h2>
          <ul className="rd-ready">
            {ready.map((x) => (
              <li key={x.id} className={x.ok ? "up" : "down"}>
                <b>{x.ok ? "✓" : "✗"}</b> {x.label} <span className="muted">· {x.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {trading ? (
        <p className="muted rd-compact">
          The number: {print ? signed(print.change, report === "WPSR" ? 3 : 0) : "—"} {cfg.unit} against a forecast of {forecast ? signed(forecast.value, 2) : "—"}: surprise {signed(surprise, 2)} ({side ?? "no side"}).
        </p>
      ) : (
      <section>
        <h2>The number</h2>
        <div className="rd-grid">
          <div>
            <div className="muted">Forecast ({cfg.unit})</div>
            <Input className="rd-input" inputMode="decimal" value={typed} onChange={(e) => {
                setTyped(e.target.value);
                if (release) saveRecord(release.at, { forecast: e.target.value });
              }} placeholder={forecast ? `${signed(forecast.value, 2)} ${forecast.source !== "typed in" ? `(${forecast.source})` : ""}` : "type the number"} aria-label="Forecast of the change" />
            {forecast && (
              <div className="rd-forecast-note" data-testid="forecast-note">
                <strong>{signed(forecast.value, 2)}</strong>{" "}
                <span className="muted">
                  {forecast.source}
                  {forecastAt !== undefined ? `, recorded ${clock.stamp(forecastAt)}` : ""}
                </span>
              </div>
            )}
            {(release?.forecasts?.length ?? 0) > 1 && (
              <div className="muted" title="every figure recorded for this release, newest first">
                changed: {release!.forecasts!.map((f) => `${signed(f.value, 2)} (${f.source}, ${clock.time(f.at)})`).join(" ← ")}
              </div>
            )}
            {consensusPaused !== undefined && (
              <div className="muted" title="Investing.com answered HTTP 403, so the app stopped asking for 12 hours and does not retry">
                Investing.com consensus paused until {clock.time(consensusPaused)}
              </div>
            )}
          </div>
          <div>
            <div className="muted">Actual</div>
            <div className="rd-big">{print ? signed(print.change, report === "WPSR" ? 3 : 0) : "—"}</div>
          </div>
          <div>
            <div className="muted">Surprise (threshold {cfg.threshold.toFixed(1)})</div>
            <div className={`rd-big ${side === "long" ? "up" : side === "short" ? "down" : ""}`}>{signed(surprise, 2)}</div>
          </div>
        </div>
        <p className={`rd-side ${side === "long" ? "up" : side === "short" ? "down" : "muted"}`}>
          {surprise === undefined
            ? print
              ? "Type or wait for a forecast to get the surprise."
              : stage === "prep" || stage === "range"
                ? "The number comes at the print."
                : "Waiting for the stored report…"
            : side === "long"
              ? "The surprise allows a LONG (a draw below forecast)."
              : side === "short"
                ? "The surprise allows a SHORT (above forecast)."
                : "Under the threshold: no side from the number; a range break alone is enough."}
        </p>
      </section>
      )}

      <section>
        <h2>Range: the hour before the print</h2>
        {range ? (
          <>
          <p className="rd-rangebox">
            <b>{num(range.high, 1)}</b> high · <b>{num(range.low, 1)}</b> low · width <b>{num(range.width, 1)}</b> <small className="muted">({range.candles} candles{range.complete ? "" : ", still building"})</small>
          </p>
          {livePrice !== undefined && (
            <p className="muted rd-live">
              Price {num(livePrice, 1)}:{" "}
              {livePrice > range.high ? `${num(livePrice - range.high, 1)} above the range` : livePrice < range.low ? `${num(range.low - livePrice, 1)} below the range` : `inside, ${num(range.high - livePrice, 1)} under the high and ${num(livePrice - range.low, 1)} over the low`}
              {stage === "window" && ` · the candle closes in ${countdown((Math.floor(nowSec / DAY_RULES.candleSec) + 1) * DAY_RULES.candleSec * 1000 - now)}`}
            </p>
          )}
          </>
        ) : (
          <p className="muted">The range starts at {clock.time(release.at - DAY_RULES.rangeMin * 60_000)}.</p>
        )}
      </section>

      {watch && range && (
        <section>
          <h2>Window: each 5-minute candle after the print</h2>
          {trading ? null : watch.candles.length === 0 ? (
            <p className="muted">The first candle closes at {clock.time(release.at + DAY_RULES.candleSec * 1000)}.</p>
          ) : (
            <table className="bt-num rd-table">
              <thead>
                <tr>
                  <th>Candle</th>
                  <th>Close</th>
                  <th>Against the range</th>
                </tr>
              </thead>
              <tbody>
                {watch.candles.map((c) => (
                  <tr key={c.time} className={!c.complete ? "muted" : ""}>
                    <td>{clock.time(c.time * 1000)}</td>
                    <td>{num(c.close, 1)}</td>
                    <td className={c.state === "above" ? "up" : c.state === "below" ? "down" : ""}>
                      {c.state === "inside" ? "inside" : c.state === "above" ? "closed above" : "closed below"}
                      {!c.complete && " (forming)"}
                      {c.against && " · skipped: against the surprise"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {signal ? (
            <div className={`rd-signal ${signal.side === "long" ? "up" : "down"}`}>
              <b>SIGNAL: {signal.side.toUpperCase()}</b> after the {clock.time(signal.candleTime * 1000)} candle closed {signal.side === "long" ? "above" : "below"} the range.
              {signal.entry === undefined ? (
                <div>Entry reference: the next candle's open (not open yet).</div>
              ) : (
                <div>
                  Entry reference <b>{num(signal.entry, 1)}</b> · R <b>{num(signal.rPoints, 1)}</b> points (1.5 × ATR {num(signal.atr, 1)}) · stop <b>{num(signal.stop, 1)}</b> · TP1 <b>{num(signal.tp1, 1)}</b> (then the stop to entry) · TP2 <b>{num(signal.tp2, 1)}</b>
                </div>
              )}
            </div>
          ) : (
            <p className="muted">{watch.cutoffReached ? "No entry: the window closed with no close beyond the range on an allowed side." : "No close beyond the range yet."}</p>
          )}
        </section>
      )}

      {!trading && <StrikeBlock strike={strike} chain={chain} side={signal?.side ?? side} price={livePrice} />}

      <p className="muted rd-foot">
        Rules: surprise {cfg.threshold.toFixed(1)} {cfg.unit}; range = the last hour before the print; entry on a 5-minute close beyond it, within {DAY_RULES.cutoffMin} minutes of the print, at the next open; R = 1.5 × ATR(14); stop 1R, TP1 +1R then the stop to entry, TP2 +2R. A break against the surprise is skipped. No order is placed here: you enter and manage the trade by hand.
      </p>
    </div>
  );
}
