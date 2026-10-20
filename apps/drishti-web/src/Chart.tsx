import { useEffect, useRef } from "react";
import { CandlestickSeries, createChart, type UTCTimestamp } from "lightweight-charts";
import { applyTick, TIMEFRAMES, type Bar, type Timeframe } from "@drishti/shared";
import { API_URL, useStore } from "./store";

const toSeries = (b: Bar) => ({ ...b, time: b.time as UTCTimestamp });

export function Chart({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { background: { color: v("--bg") }, textColor: v("--muted"), fontFamily: css.fontFamily },
      grid: { vertLines: { color: v("--panel") }, horzLines: { color: v("--panel") } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: v("--line") },
      rightPriceScale: { borderColor: v("--line") },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: v("--up"),
      downColor: v("--down"),
      wickUpColor: v("--up"),
      wickDownColor: v("--down"),
      borderVisible: false,
    });

    let last: Bar | undefined;
    let loaded = false;
    const ctrl = new AbortController();
    fetch(`${API_URL}/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []) // history optional: live candles still build from ticks
      .then((bars: Bar[]) => {
        if (ctrl.signal.aborted) return;
        series.setData(bars.map(toSeries));
        last = bars.at(-1);
        loaded = true;
      });

    const unsub = useStore.subscribe((s, p) => {
      const tick = s.quotes[symbol];
      if (!loaded || !tick || tick === p.quotes[symbol]) return;
      const bar = applyTick(last, tick, TIMEFRAMES[tf]);
      if (bar !== last) series.update(toSeries(bar));
      last = bar;
    });

    return () => {
      ctrl.abort();
      unsub();
      chart.remove();
    };
  }, [symbol, tf]);

  return <div ref={el} className="chart" />;
}
