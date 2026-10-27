import type { IndicatorDescriptor } from "openalgo-charts";
import { useLevels } from "./strategyLevels";

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
        .map((l) => ({ price: l.price, title: l.title, color: l.color, lineStyle: l.style ?? "dashed", lineWidth: 1 })),
  };
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
