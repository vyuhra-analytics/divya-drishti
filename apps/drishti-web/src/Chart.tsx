import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, createChart, TickMarkType, type Time, type UTCTimestamp } from "lightweight-charts";
import { applyTick, instrument, quoteToTick, tzOffsetSec, TIMEFRAMES, type Bar, type Timeframe } from "@drishti/shared";
import { useStore } from "./store";
import { apiUrl, decimalsFor, formatStamp, makeFormat, useSettings } from "./settings";
import { fromChartTime, toChartTime } from "./chartTime";

const toSeries = (b: Bar) => ({ ...b, time: toChartTime(b.time) as UTCTimestamp });

export function Chart({ symbol, tf }: { symbol: string; tf: Timeframe }) {
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

  useEffect(() => {
    const digits = decimalsFor(symbol, decimals);
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { background: { color: v("--panel") }, textColor: v("--muted"), fontFamily: css.fontFamily },
      grid: { vertLines: { color: v("--hover") }, horzLines: { color: v("--hover") } },
      // chart times are local wall-clock seconds (see toChartTime): ticks are labelled as UTC to read them back verbatim
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: v("--line"),
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const ms = (time as number) * 1000;
          if (type === TickMarkType.Year) return String(new Date(ms).getUTCFullYear());
          if (type === TickMarkType.Month) return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(ms);
          if (type === TickMarkType.DayOfMonth)
            return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(ms);
          return formatStamp(ms, locale, clock, "time", "UTC");
        },
      },
      rightPriceScale: { borderColor: v("--line") },
      localization: {
        locale,
        priceFormatter: makeFormat(locale, digits).price,
        timeFormatter: (time: Time) => formatStamp(fromChartTime(time as number) * 1000, locale, clock, "datetime"),
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: v("--up"),
      downColor: v("--down"),
      wickUpColor: v("--up"),
      wickDownColor: v("--down"),
      borderVisible: false,
      priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits },
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
        setNoHistory(bars.length === 0);
      });

    const unsub = useStore.subscribe((s, p) => {
      const q = s.quotes[symbol];
      const before = p.quotes[symbol];
      if (!loaded || !q || q === before) return;
      // volume delta only means something within one source
      const tick = quoteToTick(before?.source === q.source ? before : undefined, q);
      if (!tick) return;
      const tz = instrument(symbol)?.timeZone;
      const bar = applyTick(last, tick, TIMEFRAMES[tf], tz ? tzOffsetSec(tz, tick.time) : 0);
      if (bar !== last) series.update(toSeries(bar));
      last = bar;
    });

    return () => {
      ctrl.abort();
      unsub();
      chart.remove();
    };
  }, [symbol, tf, theme, colors, locale, decimals, api, clock, epoch]);

  const mcx = instrument(symbol)?.exchange === "MCX";
  return (
    <div className="chart-wrap">
      <div ref={el} className="chart" />
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
