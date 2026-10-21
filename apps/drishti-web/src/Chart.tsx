import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  createChart,
  HistogramSeries,
  LineSeries,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  applyTick,
  bollinger,
  ema,
  instrument,
  macd,
  quoteToTick,
  rsi,
  sma,
  TIMEFRAMES,
  tzOffsetSec,
  vwap,
  type Bar,
  type Point,
  type Timeframe,
} from "@drishti/shared";
import { useStore } from "./store";
import { apiUrl, decimalsFor, formatStamp, makeFormat, useSettings } from "./settings";
import { fromChartTime, toChartTime } from "./chartTime";

export const CHART_TYPES = ["candles", "bars", "line", "area"] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export const INDICATORS = ["VOL", "SMA20", "SMA50", "SMA200", "EMA20", "VWAP", "BOLL", "RSI", "MACD"] as const;
export type Indicator = (typeof INDICATORS)[number];
export const DEFAULT_INDICATORS: Indicator[] = ["VOL"];

// Line colours readable on both dark and light panels
const COLOR: Record<string, string> = {
  SMA20: "#f59f00",
  SMA50: "#4c8dff",
  SMA200: "#b07cf5",
  EMA20: "#ff7b54",
  VWAP: "#20b2aa",
  BOLL: "#8a8f98",
  RSI: "#b07cf5",
  MACD: "#4c8dff",
  SIGNAL: "#f59f00",
};

const t = (sec: number) => toChartTime(sec) as UTCTimestamp;
const line = (pts: Point[]) => pts.map((p) => ({ time: t(p.time), value: p.value }));

/** Every indicator's values for the given bars (only the enabled ones are computed). */
function compute(bars: Bar[], on: Set<Indicator>, offsetOf: (sec: number) => number) {
  return {
    SMA20: on.has("SMA20") ? sma(bars, 20) : [],
    SMA50: on.has("SMA50") ? sma(bars, 50) : [],
    SMA200: on.has("SMA200") ? sma(bars, 200) : [],
    EMA20: on.has("EMA20") ? ema(bars, 20) : [],
    VWAP: on.has("VWAP") ? vwap(bars, offsetOf) : [],
    BOLL: on.has("BOLL") ? bollinger(bars, 20, 2) : null,
    RSI: on.has("RSI") ? rsi(bars, 14) : [],
    MACD: on.has("MACD") ? macd(bars) : null,
  };
}
type Computed = ReturnType<typeof compute>;

interface Legend {
  bar: Bar;
  prevClose?: number;
  values: { label: string; color: string; text: string }[];
}

export function Chart({
  symbol,
  tf,
  type = "candles",
  indicators = DEFAULT_INDICATORS,
}: {
  symbol: string;
  tf: Timeframe;
  type?: ChartType;
  indicators?: Indicator[];
}) {
  const el = useRef<HTMLDivElement>(null);
  // the chart reads colours/format once at creation, so these rebuild it
  const theme = useSettings((s) => s.theme);
  const colors = useSettings((s) => s.colors);
  const locale = useSettings((s) => s.locale);
  const decimals = useSettings((s) => s.decimals);
  const api = useSettings((s) => s.apiUrl);
  const clock = useSettings((s) => s.clock);
  const epoch = useStore((s) => s.epoch); // reconnect → reload history (fills the gap)
  const [noHistory, setNoHistory] = useState(false);
  const [legend, setLegend] = useState<Legend | null>(null);
  const indicatorKey = [...indicators].sort().join(",");

  useEffect(() => {
    const on = new Set(indicators);
    const digits = decimalsFor(symbol, decimals);
    const fmt = makeFormat(locale, digits);
    const tz = instrument(symbol)?.timeZone;
    const offsetOf = (sec: number) => (tz ? tzOffsetSec(tz, sec * 1000) : 0);
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const up = v("--up");
    const down = v("--down");

    const chart: IChartApi = createChart(el.current!, {
      autoSize: true,
      layout: { background: { color: v("--panel") }, textColor: v("--muted"), fontFamily: css.fontFamily, attributionLogo: true },
      grid: { vertLines: { color: v("--hover") }, horzLines: { color: v("--hover") } },
      crosshair: { mode: 0 }, // free crosshair; the legend snaps to the bar under it
      // chart times are local wall-clock seconds (see toChartTime): ticks are labelled as UTC to read them back verbatim
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: v("--line"),
        tickMarkFormatter: (time: Time, kind: TickMarkType) => {
          const ms = (time as number) * 1000;
          if (kind === TickMarkType.Year) return String(new Date(ms).getUTCFullYear());
          if (kind === TickMarkType.Month) return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(ms);
          if (kind === TickMarkType.DayOfMonth)
            return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(ms);
          return formatStamp(ms, locale, clock, "time", "UTC");
        },
      },
      rightPriceScale: { borderColor: v("--line") },
      localization: {
        locale,
        priceFormatter: fmt.price,
        timeFormatter: (time: Time) => formatStamp(fromChartTime(time as number) * 1000, locale, clock, "datetime"),
      },
    });

    const priceFormat = { type: "price" as const, precision: digits, minMove: 10 ** -digits };
    const main: ISeriesApi<SeriesType> =
      type === "candles"
        ? chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceFormat })
        : type === "bars"
          ? chart.addSeries(BarSeries, { upColor: up, downColor: down, priceFormat })
          : type === "line"
            ? chart.addSeries(LineSeries, { color: v("--accent"), lineWidth: 2, priceFormat })
            : chart.addSeries(AreaSeries, {
                lineColor: v("--accent"),
                topColor: `${v("--accent")}4d`, // tokens are #rrggbb: append alpha (30%)
                bottomColor: "transparent",
                priceFormat,
              });
    const toMain = (b: Bar) =>
      type === "candles" || type === "bars"
        ? { time: t(b.time), open: b.open, high: b.high, low: b.low, close: b.close }
        : { time: t(b.time), value: b.close };

    const overlay = (color: string, width: 1 | 2 = 1, pane = 0) =>
      chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat }, pane);

    const vol = on.has("VOL")
      ? chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false })
      : null;
    vol?.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const toVol = (b: Bar) => ({ time: t(b.time), value: b.volume, color: b.close >= b.open ? `${up}66` : `${down}66` });

    const lines: Partial<Record<"SMA20" | "SMA50" | "SMA200" | "EMA20" | "VWAP", ISeriesApi<"Line">>> = {};
    for (const k of ["SMA20", "SMA50", "SMA200", "EMA20", "VWAP"] as const) if (on.has(k)) lines[k] = overlay(COLOR[k], k === "VWAP" ? 2 : 1);
    const boll = on.has("BOLL") ? { upper: overlay(COLOR.BOLL), middle: overlay(COLOR.BOLL), lower: overlay(COLOR.BOLL) } : null;

    let pane = 1;
    const rsiPane = on.has("RSI") ? pane++ : -1;
    const rsiLine = rsiPane > 0 ? chart.addSeries(LineSeries, { color: COLOR.RSI, lineWidth: 1, priceLineVisible: false }, rsiPane) : null;
    rsiLine?.createPriceLine({ price: 70, color: v("--line"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    rsiLine?.createPriceLine({ price: 30, color: v("--line"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    const macdPane = on.has("MACD") ? pane++ : -1;
    const macdSeries =
      macdPane > 0
        ? {
            hist: chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, macdPane),
            line: chart.addSeries(LineSeries, { color: COLOR.MACD, lineWidth: 1, priceLineVisible: false }, macdPane),
            signal: chart.addSeries(LineSeries, { color: COLOR.SIGNAL, lineWidth: 1, priceLineVisible: false }, macdPane),
          }
        : null;
    // sub-panes stay compact (≈20% each, 50–120 px): price keeps most of the height
    const paneHeight = Math.round(Math.min(120, Math.max(50, (el.current!.clientHeight || 300) * 0.2)));
    chart.panes().forEach((p, i) => i > 0 && p.setHeight(paneHeight));
    const histPoint = (p: Point) => ({ time: t(p.time), value: p.value, color: p.value >= 0 ? `${up}99` : `${down}99` });

    let bars: Bar[] = [];
    let ind: Computed = compute([], on, offsetOf);
    let hovering = false;

    const indicatorRows = (time: number) => {
      const at = (pts: Point[]) => pts.find((p) => p.time === time)?.value;
      const rows: Legend["values"] = [];
      for (const k of ["SMA20", "SMA50", "SMA200", "EMA20", "VWAP"] as const) {
        const val = at(ind[k]);
        if (val !== undefined) rows.push({ label: k, color: COLOR[k], text: fmt.price(val) });
      }
      if (ind.BOLL) {
        const m = at(ind.BOLL.middle);
        if (m !== undefined) rows.push({ label: "BOLL", color: COLOR.BOLL, text: `${fmt.price(at(ind.BOLL.upper))} / ${fmt.price(m)} / ${fmt.price(at(ind.BOLL.lower))}` });
      }
      const r = at(ind.RSI);
      if (r !== undefined) rows.push({ label: "RSI", color: COLOR.RSI, text: r.toFixed(1) });
      if (ind.MACD) {
        const m = at(ind.MACD.macd);
        if (m !== undefined)
          rows.push({ label: "MACD", color: COLOR.MACD, text: `${m.toFixed(digits + 1)} / ${at(ind.MACD.signal)?.toFixed(digits + 1)} / ${at(ind.MACD.histogram)?.toFixed(digits + 1)}` });
      }
      return rows;
    };
    const showLegend = (i: number) => {
      const bar = bars[i];
      setLegend(bar ? { bar, prevClose: bars[i - 1]?.close, values: indicatorRows(bar.time) } : null);
    };

    /** full redraw (history load) */
    const setAll = () => {
      ind = compute(bars, on, offsetOf);
      main.setData(bars.map(toMain));
      vol?.setData(bars.map(toVol));
      for (const [k, s] of Object.entries(lines)) s!.setData(line(ind[k as keyof typeof lines]));
      if (boll && ind.BOLL) {
        boll.upper.setData(line(ind.BOLL.upper));
        boll.middle.setData(line(ind.BOLL.middle));
        boll.lower.setData(line(ind.BOLL.lower));
      }
      rsiLine?.setData(line(ind.RSI));
      if (macdSeries && ind.MACD) {
        macdSeries.hist.setData(ind.MACD.histogram.map(histPoint));
        macdSeries.line.setData(line(ind.MACD.macd));
        macdSeries.signal.setData(line(ind.MACD.signal));
      }
      showLegend(bars.length - 1);
    };

    /** live tick: only the last point of every series changes */
    const updateLast = () => {
      ind = compute(bars, on, offsetOf); // ponytail: O(n) per tick (~5k bars, ~1/s); make indicators incremental if it ever shows in profiles
      const b = bars[bars.length - 1];
      const lastOf = (pts: Point[]) => pts[pts.length - 1];
      main.update(toMain(b));
      vol?.update(toVol(b));
      for (const [k, s] of Object.entries(lines)) {
        const p = lastOf(ind[k as keyof typeof lines]);
        if (p) s!.update({ time: t(p.time), value: p.value });
      }
      if (boll && ind.BOLL?.middle.length) {
        boll.upper.update(line([lastOf(ind.BOLL.upper)])[0]);
        boll.middle.update(line([lastOf(ind.BOLL.middle)])[0]);
        boll.lower.update(line([lastOf(ind.BOLL.lower)])[0]);
      }
      if (rsiLine && ind.RSI.length) rsiLine.update(line([lastOf(ind.RSI)])[0]);
      if (macdSeries && ind.MACD?.macd.length) {
        macdSeries.hist.update(histPoint(lastOf(ind.MACD.histogram)));
        macdSeries.line.update(line([lastOf(ind.MACD.macd)])[0]);
        macdSeries.signal.update(line([lastOf(ind.MACD.signal)])[0]);
      }
      if (!hovering) showLegend(bars.length - 1);
    };

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        hovering = false;
        return showLegend(bars.length - 1);
      }
      hovering = true;
      const real = fromChartTime(param.time as number);
      const i = bars.findIndex((b) => b.time === real);
      if (i >= 0) showLegend(i);
    });

    let loaded = false;
    const ctrl = new AbortController();
    fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []) // history optional: live candles still build from ticks
      .then((history: Bar[]) => {
        if (ctrl.signal.aborted) return;
        bars = history;
        setAll();
        loaded = true;
        setNoHistory(history.length === 0);
      });

    const unsub = useStore.subscribe((s, p) => {
      const q = s.quotes[symbol];
      const before = p.quotes[symbol];
      if (!loaded || !q || q === before) return;
      // volume delta only means something within one source
      const tick = quoteToTick(before?.source === q.source ? before : undefined, q);
      if (!tick) return;
      const lastBar = bars[bars.length - 1];
      const bar = applyTick(lastBar, tick, TIMEFRAMES[tf], tz ? tzOffsetSec(tz, tick.time) : 0);
      if (bar === lastBar) return;
      if (lastBar && bar.time === lastBar.time) bars[bars.length - 1] = bar;
      else bars.push(bar);
      updateLast();
    });

    return () => {
      ctrl.abort();
      unsub();
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- indicatorKey stands for `indicators`
  }, [symbol, tf, type, indicatorKey, theme, colors, locale, decimals, api, clock, epoch]);

  const digits = decimalsFor(symbol, decimals);
  const fmt = makeFormat(locale, digits);
  const mcx = instrument(symbol)?.exchange === "MCX";
  const lb = legend?.bar;
  const chg = lb && legend?.prevClose ? lb.close - legend.prevClose : undefined;
  return (
    <div className="chart-wrap">
      <div ref={el} className="chart" />
      {lb && (
        <div className="chart-legend" aria-live="off">
          <span>
            O <b>{fmt.price(lb.open)}</b> H <b className="up">{fmt.price(lb.high)}</b> L <b className="down">{fmt.price(lb.low)}</b> C{" "}
            <b className={lb.close >= lb.open ? "up" : "down"}>{fmt.price(lb.close)}</b>
            {chg !== undefined && (
              <b className={chg >= 0 ? "up" : "down"}>
                {" "}
                {chg >= 0 ? "+" : ""}
                {fmt.price(chg)} ({((chg / legend!.prevClose!) * 100).toFixed(2)}%)
              </b>
            )}{" "}
            Vol <b>{fmt.volume(lb.volume)}</b>
          </span>
          {legend!.values.map((r) => (
            <span key={r.label}>
              {r.label} <b style={{ color: r.color }}>{r.text}</b>
            </span>
          ))}
        </div>
      )}
      {noHistory && (
        <p className="chart-hint muted">
          {mcx
            ? "No MCX history yet: connect Upstox in Settings → Data feeds. Candles build live from now on."
            : "No history available right now. Candles build live from now on."}
        </p>
      )}
    </div>
  );
}
