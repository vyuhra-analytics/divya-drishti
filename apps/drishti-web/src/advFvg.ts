import type { Bar, IndicatorDescriptor, IndicatorInput, IndicatorSettings } from "openalgo-charts";
import { findFvgs, type FvgMitigation } from "@drishti/shared";

// Fair value gaps on the advanced chart, redrawn from the chart's own bars (any symbol, any timeframe), so they follow new candles and a changed
// timeframe by themselves. A box runs from the gap's middle candle to the candle that trades back into it (per the mitigation setting), or to the last
// bar while the gap is still open; mitigated gaps can be shown faded or hidden. The logic is shared fvg.ts (causal: a gap is known when its third
// candle closes). A trading convention, not a signal.

export const FVG_ID = "drishti-fvg";

const inputs: IndicatorInput[] = [
  { key: "min_size", type: "number", label: "Smallest gap (multiple of ATR 14; 0 = every gap)", default: 0.25, min: 0, max: 5, step: 0.05, group: "Gaps" },
  {
    key: "mitigation",
    type: "select",
    label: "A gap is filled when price",
    default: "touch",
    options: [
      { label: "touches it", value: "touch" },
      { label: "reaches its midpoint", value: "mid" },
      { label: "closes through the far edge", value: "full" },
    ],
    group: "Gaps",
  },
  { key: "show_filled", type: "boolean", label: "Show filled gaps (faded)", default: false, group: "Gaps" },
  { key: "max_boxes", type: "number", label: "Most gaps drawn (newest first)", default: 15, min: 1, max: 100, step: 1, group: "Gaps" },
  { key: "bull_color", type: "color", label: "Bullish gap", default: "#26a69a", group: "Colours" },
  { key: "bear_color", type: "color", label: "Bearish gap", default: "#ef5350", group: "Colours" },
];

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function fvgIndicator(): IndicatorDescriptor {
  return {
    id: FVG_ID,
    name: "Fair value gaps",
    category: "Smart money",
    placement: "onchart",
    inputs,
    plots: [],
    calc: () => ({}),
    draws({ bars, settings }: { bars: readonly Bar[]; settings: Readonly<IndicatorSettings> }) {
      if (bars.length < 3) return [];
      const mode = (["touch", "mid", "full"].includes(String(settings.mitigation)) ? settings.mitigation : "touch") as FvgMitigation;
      const gaps = findFvgs(bars, { minSizeAtr: Math.max(0, num(settings.min_size, 0.25)), mitigation: mode });
      const showFilled = settings.show_filled === true;
      const max = Math.max(1, Math.min(100, Math.floor(num(settings.max_boxes, 15))));
      const last = bars[bars.length - 1].time;
      return gaps
        .filter((g) => showFilled || g.mitigated === undefined)
        .slice(-max)
        .map((g) => {
          const color = String(g.dir === "bull" ? (settings.bull_color ?? "#26a69a") : (settings.bear_color ?? "#ef5350"));
          const filled = g.mitigated !== undefined;
          return {
            kind: "box",
            from: { time: bars[g.start].time, price: g.top },
            to: { time: filled ? bars[g.mitigated!].time : last, price: g.bottom },
            color,
            fillColor: color,
            opacity: filled ? 0.05 : 0.18,
            lineWidth: filled ? 0 : 1,
            text: filled ? "" : "FVG",
            fontSize: 9,
            verticalAlign: "middle",
            align: "left",
          } as const;
        }) as never;
    },
  };
}

/** Registers the study once; a failure leaves the chart as it was. */
export function registerFvg(register: (d: IndicatorDescriptor) => void, has: (id: string) => boolean): void {
  try {
    if (!has(FVG_ID)) register(fvgIndicator());
  } catch (e) {
    console.warn("fair value gap study not registered:", (e as Error).message);
  }
}
