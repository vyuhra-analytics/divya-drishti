import { SYMBOLS, TIMEFRAMES, type Timeframe } from "@drishti/shared";
import type { ComponentType } from "react";
import { Chart } from "./Chart";
import { TvWidget } from "./TvWidget";
import { useStore } from "./store";
import { useFormat, useSettings } from "./settings";
import { useWidgetSymbol, useWorkspace, type Widget, type WidgetType } from "./workspace";

function useChange(symbol: string) {
  const last = useStore((s) => s.quotes[symbol]?.price);
  const open = useStore((s) => s.day[symbol]?.open);
  const change = last !== undefined && open !== undefined ? last - open : undefined;
  const pct = change !== undefined && open ? (change / open) * 100 : undefined;
  return { last, change, pct, dir: change === undefined || change === 0 ? "" : change > 0 ? "up" : "down" };
}

/** Tick-direction coloured price; with flash on, it re-mounts per tick (key) to replay the flash animation. */
export function Price({ symbol }: { symbol: string }) {
  const price = useStore((s) => s.quotes[symbol]?.price);
  const prev = useStore((s) => s.prev[symbol]);
  const flash = useSettings((s) => s.flash);
  const fmt = useFormat();
  if (price === undefined) return <span className="muted">—</span>;
  const dir = price > prev ? "up" : price < prev ? "down" : "";
  return (
    <span key={flash ? price : undefined} className={flash && dir ? `${dir} flash-${dir}` : dir}>
      {fmt.price(price)}
    </span>
  );
}

function ChartWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const setTf = useWorkspace((s) => s.setTf);
  return (
    <>
      <div className="toolbar no-drag">
        {(Object.keys(TIMEFRAMES) as Timeframe[]).map((t) => (
          <button key={t} className={t === widget.tf ? "tf active" : "tf"} onClick={() => setTf(widget.id, t)}>
            {t}
          </button>
        ))}
      </div>
      <Chart symbol={symbol} tf={widget.tf} />
    </>
  );
}

function QuoteWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const day = useStore((s) => s.day[symbol]);
  const { change, pct, dir } = useChange(symbol);
  const fmt = useFormat();
  return (
    <div className="quote">
      <div className="quote-last">
        <Price symbol={symbol} />
        <span className={dir}>
          {change !== undefined && change > 0 ? "+" : ""}
          {fmt.price(change)} ({pct?.toFixed(2) ?? "—"}%)
        </span>
      </div>
      <dl>
        <dt>Open</dt>
        <dd>{fmt.price(day?.open)}</dd>
        <dt>High</dt>
        <dd>{fmt.price(day?.high)}</dd>
        <dt>Low</dt>
        <dd>{fmt.price(day?.low)}</dd>
        <dt>Volume</dt>
        <dd>{fmt.volume(day?.volume)}</dd>
      </dl>
    </div>
  );
}

function WatchRow({ symbol, active, onPick }: { symbol: string; active: boolean; onPick: () => void }) {
  const { pct, dir } = useChange(symbol);
  return (
    <button className={active ? "row active" : "row"} onClick={onPick}>
      <span>{symbol}</span>
      <Price symbol={symbol} />
      <span className={dir}>{pct?.toFixed(2) ?? "—"}%</span>
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
};
