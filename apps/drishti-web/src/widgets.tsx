import { instrument, SYMBOLS, TIMEFRAMES, type Quote, type Timeframe } from "@drishti/shared";
import type { ComponentType } from "react";
import { Chart, CHART_TYPES, DEFAULT_INDICATORS, INDICATORS, type ChartType, type Indicator } from "./Chart";
import { TvWidget } from "./TvWidget";
import { NewsWidget } from "./NewsWidget";
import { useStore } from "./store";
import { useClock, useFormat, useSettings } from "./settings";
import { useWidgetSymbol, useWorkspace, type Widget, type WidgetType } from "./workspace";

const SOURCE_LABEL: Record<Quote["source"], string> = { upstox: "UPSTOX", tradingview: "TV", yahoo: "YAHOO", demo: "DEMO" };

/** "CRUDEOIL FUT 19 NOV 26" → "NOV 26" */
export const contractMonth = (contract?: string) => contract?.match(/([A-Z]{3}) (\d{2})$/)?.slice(1).join(" ");

/** Change vs previous close (the provider's), not since page load. */
function useChange(symbol: string) {
  const last = useStore((s) => s.quotes[symbol]?.price);
  const prevClose = useStore((s) => s.quotes[symbol]?.prevClose);
  const change = last !== undefined && prevClose ? last - prevClose : undefined;
  const pct = change !== undefined && prevClose ? (change / prevClose) * 100 : undefined;
  return { change, pct, dir: change === undefined || change === 0 ? "" : change > 0 ? "up" : "down" };
}

/** Tick-direction coloured price; with flash on, it re-mounts per tick (key) to replay the flash animation. */
export function Price({ symbol }: { symbol: string }) {
  const price = useStore((s) => s.quotes[symbol]?.price);
  const prev = useStore((s) => s.prev[symbol]);
  const flash = useSettings((s) => s.flash);
  const fmt = useFormat(symbol);
  if (price === undefined) return <span className="muted">—</span>;
  const dir = price > prev ? "up" : price < prev ? "down" : "";
  return (
    <span key={flash ? price : undefined} className={flash && dir ? `${dir} flash-${dir}` : dir}>
      {fmt.price(price)}
    </span>
  );
}

/** Source badge, plus a DELAYED tag when the feed lags the exchange. */
export function SourceBadge({ symbol }: { symbol: string }) {
  const source = useStore((s) => s.quotes[symbol]?.source);
  const delayedBy = useStore((s) => s.quotes[symbol]?.delayedBy ?? 0);
  if (!source) return null;
  return (
    <span className="badges">
      <span className={`badge src-${source}`} title={`Source: ${source}`}>
        {SOURCE_LABEL[source]}
      </span>
      {delayedBy > 0 && (
        <span className="badge delayed" title={`Exchange data delayed ${delayedBy / 60} minutes`}>
          DELAYED {delayedBy / 60}m
        </span>
      )}
    </span>
  );
}

const INDICATOR_LABEL: Record<Indicator, string> = {
  VOL: "Volume",
  SMA20: "SMA 20",
  SMA50: "SMA 50",
  SMA200: "SMA 200",
  EMA20: "EMA 20",
  VWAP: "VWAP (session)",
  BOLL: "Bollinger 20, 2",
  RSI: "RSI 14",
  MACD: "MACD 12, 26, 9",
};

function ChartWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const setTf = useWorkspace((s) => s.setTf);
  const updateWidget = useWorkspace((s) => s.updateWidget);
  const type = widget.chartType ?? "candles";
  const on = widget.indicators ?? DEFAULT_INDICATORS;
  const menuId = `ind-${widget.id}`;
  const toggle = (k: Indicator) =>
    updateWidget(widget.id, { indicators: on.includes(k) ? on.filter((x) => x !== k) : INDICATORS.filter((x) => x === k || on.includes(x)) });
  return (
    <>
      <div className="toolbar no-drag">
        {(Object.keys(TIMEFRAMES) as Timeframe[]).map((t) => (
          <button key={t} className={t === widget.tf ? "tf active" : "tf"} onClick={() => setTf(widget.id, t)}>
            {t}
          </button>
        ))}
        <select
          className="chart-type"
          aria-label="Chart type"
          value={type}
          onChange={(e) => updateWidget(widget.id, { chartType: e.target.value as ChartType })}
        >
          {CHART_TYPES.map((c) => (
            <option key={c} value={c}>
              {c[0].toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>
        {/* native popover: light-dismiss and Esc for free */}
        <button className="tf" popoverTarget={menuId} aria-label="Indicators">
          ƒx {on.filter((k) => k !== "VOL").length || ""}
        </button>
        <div
          id={menuId}
          popover="auto"
          className="ind-menu"
          onToggle={(e) => {
            // place the popover under its button (popovers open in the top layer, centred by default)
            const btn = document.querySelector<HTMLElement>(`[popovertarget="${menuId}"]`);
            if (!btn || (e.nativeEvent as ToggleEvent).newState !== "open") return;
            const r = btn.getBoundingClientRect();
            const menu = e.currentTarget;
            menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
            menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
          }}
        >
          {INDICATORS.map((k) => (
            <label key={k}>
              <input type="checkbox" checked={on.includes(k)} onChange={() => toggle(k)} />
              {INDICATOR_LABEL[k]}
            </label>
          ))}
        </div>
        <SourceBadge symbol={symbol} />
      </div>
      <Chart symbol={symbol} tf={widget.tf} type={type} indicators={on} />
    </>
  );
}

function QuoteWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const q = useStore((s) => s.quotes[symbol]);
  const inst = instrument(symbol);
  const { change, pct, dir } = useChange(symbol);
  const fmt = useFormat(symbol);
  const clock = useClock();
  return (
    <div className="quote">
      <div className="quote-head">
        <span>{inst?.name ?? symbol}</span>
        <span className="muted">{q?.contract ?? ""}</span>
      </div>
      <div className="quote-last">
        <Price symbol={symbol} />
        <span className="muted">{inst?.currency}</span>
        <span className={dir}>
          {change !== undefined && change > 0 ? "+" : ""}
          {fmt.price(change)} ({pct !== undefined ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}` : "—"}%)
        </span>
      </div>
      <dl>
        <dt>Open</dt>
        <dd>{fmt.price(q?.open)}</dd>
        <dt>High</dt>
        <dd>{fmt.price(q?.high)}</dd>
        <dt>Low</dt>
        <dd>{fmt.price(q?.low)}</dd>
        <dt>Prev close</dt>
        <dd>{fmt.price(q?.prevClose)}</dd>
        <dt>Volume</dt>
        <dd>{fmt.volume(q?.volume)}</dd>
        <dt>Lot</dt>
        <dd>{inst?.lot ?? "—"}</dd>
      </dl>
      <div className="quote-foot">
        <SourceBadge symbol={symbol} />
        {q && <span className="muted">{clock.time(q.time)}</span>}
      </div>
    </div>
  );
}

function WatchRow({ symbol, active, onPick }: { symbol: string; active: boolean; onPick: () => void }) {
  const { pct, dir } = useChange(symbol);
  const contract = useStore((s) => s.quotes[symbol]?.contract);
  const delayed = useStore((s) => (s.quotes[symbol]?.delayedBy ?? 0) > 0);
  const inst = instrument(symbol);
  return (
    <button className={active ? "row active" : "row"} onClick={onPick} title={`${inst?.name} · ${symbol}`}>
      <span className="row-name">
        {symbol.split(":")[1]}
        <small className="muted">
          {contractMonth(contract) ?? inst?.exchange}
          {delayed && " · 10m delay"}
        </small>
      </span>
      <Price symbol={symbol} />
      <span className={dir}>{pct !== undefined ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}</span>
    </button>
  );
}

function WatchlistWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const loadSymbol = useWorkspace((s) => s.loadSymbol);
  return (
    <div className="watchlist">
      {SYMBOLS.map((s) => (
        <WatchRow key={s} symbol={s} active={s === symbol} onPick={() => loadSymbol(widget.id, s)} />
      ))}
    </div>
  );
}

/** linked: widget follows a link group (shows group dot). showSymbol: symbol in the title bar. */
export const WIDGETS: Record<
  WidgetType,
  { title: string; component: ComponentType<{ widget: Widget }>; linked: boolean; showSymbol: boolean }
> = {
  chart: { title: "Chart", component: ChartWidget, linked: true, showSymbol: true },
  quote: { title: "Quote", component: QuoteWidget, linked: true, showSymbol: true },
  watchlist: { title: "Watchlist", component: WatchlistWidget, linked: true, showSymbol: false },
  tv: { title: "Live TV", component: TvWidget, linked: false, showSymbol: false },
  news: { title: "News", component: NewsWidget, linked: true, showSymbol: false },
};
