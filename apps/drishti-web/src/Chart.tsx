import { useEffect, useRef } from "react";
import { CandlestickSeries, createChart, type UTCTimestamp } from "lightweight-charts";
import { applyTick, TIMEFRAMES, type Bar, type Timeframe } from "@drishti/shared";
import { useStore } from "./store";
import { apiUrl, makeFormat, useSettings } from "./settings";

const toSeries = (b: Bar) => ({ ...b, time: b.time as UTCTimestamp });

export function Chart({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  const el = useRef<HTMLDivElement>(null);
  // the chart reads colours/format once at creation, so these rebuild it
  const theme = useSettings((s) => s.theme);
  const colors = useSettings((s) => s.colors);
  const locale = useSettings((s) => s.locale);
  const decimals = useSettings((s) => s.decimals);
  const api = useSettings((s) => s.apiUrl);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { background: { color: v("--panel") }, textColor: v("--muted"), fontFamily: css.fontFamily },
      grid: { vertLines: { color: v("--hover") }, horzLines: { color: v("--hover") } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: v("--line") },
      rightPriceScale: { borderColor: v("--line") },
      localization: { locale, priceFormatter: makeFormat(locale, decimals).price },
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
    fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { signal: ctrl.signal })
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
  }, [symbol, tf, theme, colors, locale, decimals, api]);

  return <div ref={el} className="chart" />;
}
