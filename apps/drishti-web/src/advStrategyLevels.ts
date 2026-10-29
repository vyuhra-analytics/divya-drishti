import type { IndicatorDescriptor, IndicatorDrawing } from "openalgo-charts";
import { useLevels, type LevelInput } from "./strategyLevels";

// The "Strategy levels" study of the advanced chart: draws, as price lines, the levels the Report day and USIB panels publish (strategyLevels.ts). It has no
// data of its own; it recomputes whenever a panel publishes. The report-day and USIB desks add it to their chart on their own.

export const STRATEGY_LEVELS_ID = "drishti-strategy-levels";

export function strategyLevelsIndicator(): IndicatorDescriptor {
  return {
    id: STRATEGY_LEVELS_ID,
    name: "Strategy levels",
    category: "Sessions",
    placement: "onchart",
    inputs: [],
    plots: [],
    calc: () => ({}),
    attach: (ctx) => useLevels.subscribe(() => ctx.requestRecompute()),
    levels: () =>
      Object.values(useLevels.getState().sources)
        .flat()
        .filter((l) => l.from === undefined)
        .map((l) => ({ price: l.price, title: l.title, color: l.color, lineStyle: l.style ?? "dashed", lineWidth: 1 })),
    draws: ({ bars }) => rangeDrawings(useLevels.getState().sources, bars.length ? Number(bars[bars.length - 1].time) : undefined),
  };
}

/** The levels that carry a start time, as drawings: two or more in one source make a shaded box with its label, a single one a line from its start. */
export function rangeDrawings(sources: Record<string, LevelInput[]>, lastTime: number | undefined) {
  if (lastTime === undefined) return [];
  const out: IndicatorDrawing[] = [];
  for (const levels of Object.values(sources)) {
    const part = levels.filter((l) => l.from !== undefined && l.from < lastTime);
    if (!part.length) continue;
    const from = Math.min(...part.map((l) => l.from!));
    const color = part[0].color;
    if (part.length === 1) {
      out.push({ kind: "line", from: { time: from, price: part[0].price }, to: { time: lastTime, price: part[0].price }, color, lineWidth: 1, lineStyle: part[0].style ?? "solid" });
      continue;
    }
    const hi = Math.max(...part.map((l) => l.price));
    const lo = Math.min(...part.map((l) => l.price));
    out.push({ kind: "box", from: { time: from, price: hi }, to: { time: lastTime, price: lo }, color, fillColor: color, opacity: 0.06, lineWidth: 1, text: part.map((l) => `${l.title} ${l.price}`).join("\n"), fontSize: 10, verticalAlign: "top", align: "left" });
  }
  return out;
}

export function registerStrategyLevels(register: (d: IndicatorDescriptor) => void, has: (id: string) => boolean): void {
  try {
    if (!has(STRATEGY_LEVELS_ID)) register(strategyLevelsIndicator());
  } catch (e) {
    console.warn("strategy levels study not registered:", (e as Error).message);
  }
}

/** Add the study to a chart widget once it is ready, if the chart does not have it already (a few tries: the chart builds asynchronously). */
export function ensureStrategyLevels(widget: unknown): void {
  const w = widget as { isDestroyed?: boolean; chart?: { indicators?: () => { indicatorId?: string }[]; addIndicator?: (id: string) => unknown } };
  let tries = 0;
  const attempt = () => {
    tries++;
    try {
      if (w.isDestroyed) return;
      if (w.chart?.indicators && w.chart.addIndicator) {
        if (!w.chart.indicators().some((i) => i.indicatorId === STRATEGY_LEVELS_ID)) w.chart.addIndicator(STRATEGY_LEVELS_ID);
        return;
      }
    } catch {
      /* the chart is not ready yet */
    }
    if (tries < 10) setTimeout(attempt, 800);
  };
  setTimeout(attempt, 800);
}
