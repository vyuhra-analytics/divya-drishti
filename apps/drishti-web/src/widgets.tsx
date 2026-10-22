import { daysToExpiry, describeProvenance, instrument, quoteProvenance, SYMBOLS, TIMEFRAMES, type Quote, type Timeframe } from "@drishti/shared";
import type { ComponentType } from "react";
import { Chart, CHART_TYPES, DEFAULT_INDICATORS, INDICATORS, type ChartType, type Indicator } from "./Chart";
import { TvWidget } from "./TvWidget";
import { HeatmapWidget, ScreenerWidget } from "./EnergyPanels";
import { OptionsWidget } from "./OptionsPanel";
import { InsiderWidget } from "./InsiderPanel";
import { CalendarWidget } from "./CalendarPanel";
import { AlertsWidget } from "./AlertsPanel";
import { AdvancedChartWidget } from "./AdvancedChart";
import { BriefingWidget } from "./BriefingPanel";
import { CotWidget } from "./CotPanel";
import { ChokepointsWidget } from "./ChokepointsPanel";
import { CurveWidget } from "./CurvePanel";
import { EiaWidget } from "./EiaPanel";
import { RecapWidget } from "./RecapPanel";
import { CostsWidget } from "./CostsPanel";
import { BacktestWidget } from "./BacktestPanel";
import { PaperWidget } from "./PaperPanel";
import { QualityWidget } from "./QualityPanel";
import { OptionChainWidget } from "./OptionChainPanel";
import { useFreshness } from "./market";
import { SourceBadge } from "./SourceBadge";
export { SourceBadge };
import { NewsWidget } from "./NewsWidget";
import { useStore } from "./store";
import { sparkPoints } from "./spark";
import { useClock, useFormat, useSettings } from "./settings";
import { useWidgetSymbol, useWorkspace, type Widget, type WidgetType } from "./workspace";

/** "CRUDEOIL FUT 19 NOV 26" → "NOV 26" */
const contractMonth = (contract?: string) => contract?.match(/([A-Z]{3}) (\d{2})$/)?.slice(1).join(" ");

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
  const fresh = useFreshness(symbol);
  if (price === undefined) return <span className="muted">—</span>;
  const dir = price > prev ? "up" : price < prev ? "down" : "";
  const cls = [flash && dir ? `${dir} flash-${dir}` : dir, fresh !== "live" && "not-live"].filter(Boolean).join(" ");
  return (
    <span key={flash ? price : undefined} className={cls} title={fresh === "live" ? undefined : fresh === "closed" ? "Market closed: last price" : "No update from the feed for over a minute"}>
      {fmt.price(price)}
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

/** Where the last price sits in today's range (with the open marked): a glance at intraday position. */
function DayRange({ low, high, last, open }: { low?: number; high?: number; last?: number; open?: number }) {
  if (low === undefined || high === undefined || last === undefined || high <= low) return null;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - low) / (high - low)) * 100))}%`;
  return (
    <div className="day-range" title="Day range: low → high">
      <div className="track">
        {open !== undefined && <span className="open-mark" style={{ left: at(open) }} />}
        <span className="last-mark" style={{ left: at(last) }} />
      </div>
    </div>
  );
}

function QuoteWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const q = useStore((s) => s.quotes[symbol]);
  const inst = instrument(symbol);
  const { change, pct, dir } = useChange(symbol);
  const fmt = useFormat(symbol);
  const clock = useClock();
  const days = daysToExpiry(q?.contract, Date.now());
  const spread = q?.bid !== undefined && q?.ask !== undefined ? q.ask - q.bid : undefined;
  const book = q?.totalBuyQty !== undefined && q?.totalSellQty !== undefined ? q.totalBuyQty + q.totalSellQty : 0;
  const buyPct = book > 0 ? (q!.totalBuyQty! / book) * 100 : undefined;
  const cell = (label: string, value: string, title?: string) => (
    <>
      <dt title={title}>{label}</dt>
      <dd>{value}</dd>
    </>
  );
  return (
    <div className="quote">
      <div className="quote-head">
        <span>{inst?.name ?? symbol}</span>
        <span className="muted">
          {q?.contract ?? ""}
          {days !== undefined && <b className={days <= 3 ? "expiry soon" : "expiry"}>{days === 0 ? "expires today" : `${days}d to expiry`}</b>}
        </span>
      </div>
      <div className="quote-last">
        <Price symbol={symbol} />
        <span className="muted">{inst?.currency}</span>
        <span className={dir}>
          {change !== undefined && change > 0 ? "+" : ""}
          {fmt.price(change)} ({pct !== undefined ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}` : "—"}%)
        </span>
      </div>
      {(q?.bid !== undefined || q?.ask !== undefined) && (
        <div className="quote-book">
          <span>
            <span className="muted">Bid</span> <b className="up">{fmt.price(q?.bid)}</b>
            {q?.bidQty !== undefined && <span className="muted"> ×{q.bidQty}</span>}
          </span>
          <span className="muted">spread {fmt.price(spread)}</span>
          <span>
            <span className="muted">Ask</span> <b className="down">{fmt.price(q?.ask)}</b>
            {q?.askQty !== undefined && <span className="muted"> ×{q.askQty}</span>}
          </span>
        </div>
      )}
      <DayRange low={q?.low} high={q?.high} last={q?.price} open={q?.open} />
      <dl className="quote-grid">
        {cell("Open", fmt.price(q?.open))}
        {cell("Prev close", fmt.price(q?.prevClose))}
        {cell("High", fmt.price(q?.high))}
        {cell("Low", fmt.price(q?.low))}
        {cell("Volume", fmt.volume(q?.volume))}
        {cell("OI", fmt.volume(q?.oi), "Open interest: contracts outstanding")}
        {cell("ATP", fmt.price(q?.atp), "Average traded price today (VWAP)")}
        {cell("Lot", inst?.lot ?? "—")}
      </dl>
      {buyPct !== undefined && (
        <div className="quote-pressure" title="Pending buy vs sell quantity in the order book">
          <span className="up">Buy {buyPct.toFixed(0)}%</span>
          <div className="bar">
            <span style={{ width: `${buyPct}%` }} />
          </div>
          <span className="down">{(100 - buyPct).toFixed(0)}% Sell</span>
        </div>
      )}
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
  const trail = useStore((s) => s.trail[symbol]);
  const inst = instrument(symbol);
  return (
    <button className={active ? "row active" : "row"} onClick={onPick} title={`${inst?.name} · ${symbol}`}>
      <span className="row-name">
        {symbol.split(":")[1]}
        <span className="row-sub">
          <small className="muted">
            {contractMonth(contract) ?? inst?.exchange}
            {delayed && " · 10m delay"}
          </small>
          <SourceBadge symbol={symbol} compact />
        </span>
      </span>
      <svg className={`spark ${trail && trail[trail.length - 1] < trail[0] ? "down" : "up"}`} viewBox="0 0 56 18" aria-hidden="true">
        <polyline points={sparkPoints(trail ?? [], 56, 18)} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
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
  advchart: { title: "Chart", component: AdvancedChartWidget, linked: true, showSymbol: true },
  chart: { title: "Simple Chart", component: ChartWidget, linked: true, showSymbol: true },
  quote: { title: "Quote", component: QuoteWidget, linked: true, showSymbol: true },
  watchlist: { title: "Watchlist", component: WatchlistWidget, linked: true, showSymbol: false },
  tv: { title: "Live TV", component: TvWidget, linked: false, showSymbol: false },
  news: { title: "News", component: NewsWidget, linked: true, showSymbol: false },
  heatmap: { title: "Energy Heatmap", component: HeatmapWidget, linked: false, showSymbol: false },
  screener: { title: "Energy Screener", component: ScreenerWidget, linked: false, showSymbol: false },
  options: { title: "Options Chain", component: OptionsWidget, linked: true, showSymbol: true },
  insider: { title: "Insider Trades", component: InsiderWidget, linked: false, showSymbol: false },
  calendar: { title: "Energy Calendar", component: CalendarWidget, linked: false, showSymbol: false },
  alerts: { title: "Alerts", component: AlertsWidget, linked: false, showSymbol: false },
  briefing: { title: "AI Briefing", component: BriefingWidget, linked: true, showSymbol: true },
  cot: { title: "Positioning (COT)", component: CotWidget, linked: true, showSymbol: false },
  chokepoints: { title: "Chokepoints", component: ChokepointsWidget, linked: false, showSymbol: false },
  curve: { title: "Futures curve", component: CurveWidget, linked: true, showSymbol: false },
  eia: { title: "EIA petroleum data", component: EiaWidget, linked: false, showSymbol: false },
  recap: { title: "Energy recap", component: RecapWidget, linked: true, showSymbol: true },
  costs: { title: "Costs and size", component: CostsWidget, linked: true, showSymbol: true },
  backtest: { title: "Strategy tester", component: BacktestWidget, linked: true, showSymbol: true },
  paper: { title: "Paper trading", component: PaperWidget, linked: true, showSymbol: true },
  quality: { title: "Data quality", component: QualityWidget, linked: false, showSymbol: false },
  optionchain: { title: "Option chain (detailed)", component: OptionChainWidget, linked: true, showSymbol: true },
};
