import { useEffect, useRef, useState } from "react";
import { SourceBadge } from "./SourceBadge";
import { instrument, type Bar } from "@drishti/shared";
import type { Widget as OaWidget } from "openalgo-charts/widget";
import type { ReplayController, ReplayState, TickMarkType } from "openalgo-charts";
import { ADV_INTERVALS, ourFeed, timeframeOf } from "./advFeed";
import { advStorage } from "./advStorage";
import { registerFlowStudies } from "./advFlow";
import { registerKillzones } from "./advKillzones";
import { apiUrl, formatStamp, useClock, useSettings } from "./settings";
import { useWidgetSymbol, type Widget } from "./workspace";

const SPEEDS = [1, 2, 5, 10, 25];

/** The viewer's own time zone: every time in the app is shown in it, and the chart follows. */
const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Axis and crosshair labels in the app's time format (Settings: 12/24-hour clock and number/date locale) and the system zone.
 * Read from the settings store on every call, so a change applies the next time the chart repaints.
 * `kind` is the library's tick class (`year`, `month`, `day`, `time`, `timeWithSeconds`); no kind is the crosshair label: date and time.
 */
function chartTimeLabel(utcSeconds: number, kind?: TickMarkType): string {
  const { locale, clock } = useSettings.getState();
  const zone = systemZone();
  const ms = utcSeconds * 1000;
  if (kind === "year") return new Intl.DateTimeFormat(locale, { year: "numeric", timeZone: zone }).format(ms);
  if (kind === "month") return new Intl.DateTimeFormat(locale, { month: "short", timeZone: zone }).format(ms);
  if (kind === "day") return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: zone }).format(ms);
  return formatStamp(ms, locale, clock, kind === undefined ? "datetime" : "time", zone);
}
const REPLAY_BARS = 150; // replay starts this many bars before the end of the stored history
const BAR_MS = 800; // wall-clock per bar at 1x

/**
 * The view a freshly loaded chart should have: the last ~60 bars plus a little room. A restored or half-loaded chart can be
 * left looking at indexes that don't exist (the viewport of a 3,600-bar history applied to the 175 bars actually loaded) and
 * draws nothing. Returns the range to apply, or null when the current one is fine.
 */
export function healedRange(range: { from: number; to: number } | null, bars: number): { from: number; to: number } | null {
  if (bars < 2 || !range) return null;
  const sane = range.to >= bars - 3 && range.from <= bars + 5; // the latest bars are in view
  return sane ? null : { from: Math.max(0, bars - 60), to: bars + 3 };
}
const SETTLE_MS = 8000; // after (re)creation and after a symbol or interval change the view is checked this long
const stored = async (symbol: string, tf: string): Promise<Bar[]> => {
  const res = await fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}&source=db`);
  return res.ok ? ((await res.json()) as Bar[]) : [];
};

/**
 * Advanced chart: openalgo-charts' full terminal (drawing tools, 100+ indicators, chart types such as Heikin Ashi)
 * running on our history and live feed, with a replay mode over the candles stored in our own database.
 * Loaded on first use (separate chunks); the Simple Chart stays available.
 */
export function AdvancedChartWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const theme = useSettings((s) => s.theme);
  const clock = useClock();
  const host = useRef<HTMLDivElement>(null);
  const oa = useRef<OaWidget | null>(null);
  const replay = useRef<ReplayController | null>(null);
  const settleUntil = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [replayState, setReplayState] = useState<ReplayState | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayNote, setReplayNote] = useState<string | null>(null);
  // the widget is created once; later symbol/theme changes go through its API (refs hold the values it was created with)
  const first = useRef({ symbol, theme });
  first.current = { symbol, theme };

  useEffect(() => {
    let cancelled = false;
    let created: OaWidget | null = null;
    Promise.all([import("openalgo-charts/widget"), import("openalgo-charts/indicators"), import("openalgo-charts/draw"), import("openalgo-charts/transform")])
      .then(async ([{ createWidget }, indicators]) => {
        if (cancelled || !host.current) return;
        // estimated order flow studies (data from our own recording of the feed); registered once, a failure never touches the chart
        try {
          const lib = await import("openalgo-charts");
          registerFlowStudies(lib.registerIndicator, indicators.createTier2Indicator, lib.hasIndicator);
          registerKillzones(lib.registerIndicator, lib.hasIndicator);
        } catch (e) {
          console.warn("order flow studies unavailable:", (e as Error).message);
        }
        if (cancelled || !host.current) return;
        created = createWidget(host.current, {
          feed: ourFeed(() => replay.current !== null),
          symbol: first.current.symbol,
          exchange: instrument(first.current.symbol)?.exchange ?? "MCX",
          interval: widget.tf === "1d" ? "1D" : widget.tf,
          intervals: ADV_INTERVALS,
          theme: first.current.theme,
          mobile: "auto",
          timezone: systemZone(),
          locale: useSettings.getState().locale,
          timeFormatter: chartTimeLabel,
          persist: `drishti-adv-${widget.id}`, // drawings, indicators and layout survive reloads; the view does not (advStorage)
          storage: advStorage(first.current.symbol, instrument(first.current.symbol)?.exchange ?? "MCX"),
          branding: false, // no "Chart by OpenAlgo" corner mark or toolbar label (supported option; their NOTICE stays with the package)
        });
        oa.current = created;
        settleUntil.current = Date.now() + SETTLE_MS;
        if (import.meta.env.DEV) ((window as unknown as { __adv?: Record<string, OaWidget> }).__adv ??= {})[widget.id] = created; // dev-only handle for debugging in the console
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      replay.current?.stop();
      replay.current = null;
      oa.current = null;
      created?.destroy();
    };
  }, [widget.id]); // eslint-disable-line react-hooks/exhaustive-deps -- see `first`

  useEffect(() => {
    const w = oa.current;
    if (w && !w.isDestroyed && w.symbol() !== symbol) {
      stopReplay();
      settleUntil.current = Date.now() + SETTLE_MS;
      w.setSymbol(symbol, instrument(symbol)?.exchange);
    }
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const w = oa.current;
    if (w && !w.isDestroyed && w.theme() !== theme) w.setTheme(theme);
  }, [theme]);

  // while a chart is settling, put the view back on the latest bars if it was left pointing at nothing
  useEffect(() => {
    let interval = "";
    const id = setInterval(() => {
      const w = oa.current;
      if (!w || w.isDestroyed || replay.current) return;
      if (w.interval() !== interval) {
        if (interval) settleUntil.current = Date.now() + SETTLE_MS; // the user (or the library) changed the interval
        interval = w.interval();
      }
      if (Date.now() > settleUntil.current) return;
      const fix = healedRange(w.chart.getVisibleLogicalRange(), w.series.getData().length);
      if (fix) w.chart.setVisibleLogicalRange(fix);
    }, 700);
    return () => clearInterval(id);
  }, []);

  function stopReplay() {
    replay.current?.stop(); // puts the full history and the viewport back
    replay.current = null;
    settleUntil.current = Date.now() + SETTLE_MS;
    setReplayState(null);
  }

  async function startReplay() {
    const w = oa.current;
    if (!w || w.isDestroyed) return;
    setReplayBusy(true);
    setReplayNote(null);
    try {
      const tf = timeframeOf(w.interval());
      if (!tf) throw new Error("Pick 1m, 5m, 15m, 1h or 1D to replay");
      const bars = await stored(w.symbol(), tf);
      if (bars.length < 20) throw new Error(`Only ${bars.length} stored ${tf} candles for ${w.symbol()}: replay needs a longer stored history`);
      // finer stored candles (1m under a 5m chart) make each bar form step by step like a live one
      const sub = tf === "5m" || tf === "15m" ? await stored(w.symbol(), "1m") : [];
      const { ReplayController } = await import("openalgo-charts");
      const rc = new ReplayController(w.chart, {
        series: w.series,
        bars,
        ...(sub.length ? { subBars: sub } : {}),
        startIndex: Math.max(0, bars.length - REPLAY_BARS),
        barMs: BAR_MS,
        onFrame: (st) => {
          setReplayState(st);
          // at the last bar there is nothing left to play: show Play again, not Pause
          if (st.playing && st.index >= st.total - 1 && st.subIndex >= st.subSteps - 1) replay.current?.pause();
        },
      });
      replay.current = rc;
      setReplayState(rc.state());
      setReplayNote(sub.length ? `Stored ${tf} candles, formed from stored 1m candles` : `Stored ${tf} candles`);
    } catch (e) {
      setReplayNote(e instanceof Error ? e.message : String(e));
    } finally {
      setReplayBusy(false);
    }
  }

  if (error) return <p className="empty muted">Advanced chart failed to load: {error}</p>;
  const rs = replayState;
  const rc = replay.current;
  return (
    <div className="adv-wrap">
      <div className="adv-replay no-drag">
        {!rs ? (
          <button className="btn" onClick={startReplay} disabled={replayBusy} title="Replay the stored candles from our database, bar by bar">
            {replayBusy ? "Loading…" : "⏮ Replay"}
          </button>
        ) : (
          <>
            <button className="btn" aria-label={rs.playing ? "Pause replay" : "Play replay"} onClick={() => (rs.playing ? rc?.pause() : rc?.play({ speed: rs.speed }))}>
              {rs.playing ? "❚❚" : "▶"}
            </button>
            <button className="btn" aria-label="Back one bar" onClick={() => rc?.stepBack()} disabled={rs.index <= 0}>
              ◀
            </button>
            <button className="btn" aria-label="Forward one bar" onClick={() => rc?.step()} disabled={rs.index >= rs.total - 1}>
              ▶|
            </button>
            <select aria-label="Replay speed" value={rs.speed} onChange={(e) => (rs.playing ? rc?.play({ speed: Number(e.target.value) }) : setReplayState({ ...rs, speed: Number(e.target.value) }))}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
            <span className="muted adv-replay-pos">
              bar {rs.index + 1} / {rs.total}
              {rs.bar ? ` · ${clock.stamp(rs.bar.time * 1000)}` : ""}
            </span>
            <button className="btn" onClick={stopReplay}>
              Stop · back to live
            </button>
          </>
        )}
        {replayNote && <span className="muted adv-replay-note">{replayNote}</span>}
        <SourceBadge symbol={symbol} />
      </div>
      <div ref={host} className="adv-chart no-drag" />
    </div>
  );
}
