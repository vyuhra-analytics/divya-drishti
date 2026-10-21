import { useEffect, useRef, useState } from "react";
import { instrument } from "@drishti/shared";
import type { Widget as OaWidget } from "openalgo-charts/widget";
import { ADV_INTERVALS, ourFeed } from "./advFeed";
import { useSettings } from "./settings";
import { useWidgetSymbol, type Widget } from "./workspace";

/**
 * Advanced chart: openalgo-charts' full terminal (drawing tools, 100+ indicators, replay, chart types such as Heikin Ashi)
 * running on our history and live feed. Loaded on first use (a separate ~0.4 MB chunk); the standard Chart stays the default.
 */
export function AdvancedChartWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const theme = useSettings((s) => s.theme);
  const host = useRef<HTMLDivElement>(null);
  const oa = useRef<OaWidget | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the widget is created once; later symbol/theme changes go through its API (refs hold the values it was created with)
  const first = useRef({ symbol, theme });
  first.current = { symbol, theme };

  useEffect(() => {
    let cancelled = false;
    let created: OaWidget | null = null;
    Promise.all([import("openalgo-charts/widget"), import("openalgo-charts/indicators"), import("openalgo-charts/draw"), import("openalgo-charts/transform")])
      .then(([{ createWidget }]) => {
        if (cancelled || !host.current) return;
        created = createWidget(host.current, {
          feed: ourFeed(),
          symbol: first.current.symbol,
          exchange: instrument(first.current.symbol)?.exchange ?? "MCX",
          interval: widget.tf === "1d" ? "1D" : widget.tf,
          intervals: ADV_INTERVALS,
          theme: first.current.theme,
          mobile: "auto",
          persist: `drishti-adv-${widget.id}`, // drawings, indicators and layout survive reloads
        });
        oa.current = created;
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      oa.current = null;
      created?.destroy();
    };
  }, [widget.id]); // eslint-disable-line react-hooks/exhaustive-deps -- see `first`

  useEffect(() => {
    const w = oa.current;
    if (w && !w.isDestroyed && w.symbol() !== symbol) w.setSymbol(symbol, instrument(symbol)?.exchange);
  }, [symbol]);
  useEffect(() => {
    const w = oa.current;
    if (w && !w.isDestroyed && w.theme() !== theme) w.setTheme(theme);
  }, [theme]);

  if (error) return <p className="empty muted">Advanced chart failed to load: {error}</p>;
  return <div ref={host} className="adv-chart no-drag" />;
}
