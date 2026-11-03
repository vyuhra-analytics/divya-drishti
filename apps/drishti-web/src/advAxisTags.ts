// Level names on the price axis. A study that wants its levels named puts `axisTags` in the store its `calc` receives; this keeps one short price line per tag on
// the chart (the tag text is the name and price, drawn in the axis column, with only a stub of line: the full line comes from the study's own drawings, which start
// where their day starts). Polled, because a study cannot reach the chart object itself. A study that is removed or hidden loses its tags on the next tick.

export interface AxisTag {
  price: number;
  color: string;
  text: string;
}

interface Line {
  setOptions?(patch: Record<string, unknown>): void;
}
interface ChartLike {
  addPriceLine(opts: Record<string, unknown>): Line;
  removePrimitive(p: Line): void;
  indicators(): { _store?: { axisTags?: AxisTag[] }; _visible?: boolean }[];
}

const key = (t: AxisTag) => `${t.text}|${t.price}|${t.color}`;

/** The tags every visible study on the chart wants shown, de-duplicated. */
export function wantedTags(chart: Pick<ChartLike, "indicators">): AxisTag[] {
  const seen = new Map<string, AxisTag>();
  for (const i of chart.indicators()) {
    if (i._visible === false) continue;
    for (const t of i._store?.axisTags ?? []) if (Number.isFinite(t.price)) seen.set(key(t), t);
  }
  return [...seen.values()];
}

/** Starts keeping the chart's axis tags in step with its studies; returns the function that stops it and removes them. */
export function startAxisTags(chart: ChartLike, everyMs = 700): () => void {
  const shown = new Map<string, Line>();
  const sync = () => {
    try {
      const want = new Map(wantedTags(chart).map((t) => [key(t), t]));
      for (const [k, line] of shown) {
        if (!want.has(k)) {
          chart.removePrimitive(line);
          shown.delete(k);
        }
      }
      for (const [k, t] of want) {
        if (!shown.has(k)) shown.set(k, chart.addPriceLine({ price: t.price, color: t.color, label: t.text, id: `axis-tag:${k}`, lineWidth: 1, extentFromRight: 0.015 }));
      }
    } catch {
      /* the chart is not ready, or is being destroyed: try again on the next tick */
    }
  };
  const id = setInterval(sync, everyMs);
  sync();
  return () => {
    clearInterval(id);
    for (const line of shown.values()) {
      try {
        chart.removePrimitive(line);
      } catch {
        /* the chart is already gone */
      }
    }
    shown.clear();
  };
}
