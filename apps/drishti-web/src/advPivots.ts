import type { IndicatorDescriptor, IndicatorInput } from "openalgo-charts";
import type { AxisTag } from "./advAxisTags";
import { sessionPivots, type PivotVariant } from "@drishti/shared";

// Pivot levels on the advanced chart: flat lines for each session, computed from the previous session's high, low and close (shared pivots.ts), so they
// are the same on every 1-minute or 5-minute candle and jump only when a new session opens. Sessions come from the candles (the overnight close, the
// daily break, weekends), so MCX and NYMEX both work; nothing is drawn on a daily chart. The newest session's lines carry a label with the price.
// A widely watched price, not a forecast.

export const PIVOTS_ID = "drishti-pivots";

const PIVOT = "#ffb300";
const RES = "#ef5350";
const SUP = "#26a69a";
const PREV = "#90a4ae";

const inputs: IndicatorInput[] = [
  {
    key: "variant",
    type: "select",
    label: "Formula",
    default: "classic",
    options: [
      { label: "Classic (P = (H+L+C)/3)", value: "classic" },
      { label: "Fibonacci (0.382, 0.618, 1.0 of the range)", value: "fibonacci" },
      { label: "Camarilla (close +/- 1.1 x range / 12, 6, 4, 2)", value: "camarilla" },
    ],
  },
  { key: "days", type: "number", label: "Sessions drawn (newest)", default: 3, min: 1, max: 20, step: 1 },
  { key: "show_prev", type: "boolean", label: "Previous session high and low", default: true },
  { key: "show_labels", type: "boolean", label: "Labels on the newest session", default: true },
  { key: "color_pivot", type: "color", label: "Pivot colour", default: PIVOT },
  { key: "color_res", type: "color", label: "Resistance colour", default: RES },
  { key: "color_sup", type: "color", label: "Support colour", default: SUP },
  { key: "min_gap", type: "number", label: "Shortest break between sessions (minutes)", default: 30, min: 5, max: 600, step: 5 },
];

const colorOf = (name: string, s: Readonly<Record<string, unknown>>) =>
  String(name === "P" ? (s.color_pivot ?? PIVOT) : name.startsWith("R") ? (s.color_res ?? RES) : (s.color_sup ?? SUP));
const fmt = (v: number) => String(Number(v.toFixed(2)));

/** The newest session's level names as price-axis tags (advAxisTags.ts). */
export function pivotTags(bars: readonly { time: number; high: number; low: number; close: number }[], settings: Readonly<Record<string, unknown>>): AxisTag[] {
  if (settings.show_labels === false) return [];
  const variant = (["classic", "fibonacci", "camarilla"].includes(String(settings.variant)) ? settings.variant : "classic") as PivotVariant;
  const gap = Math.max(5, Math.min(600, Number(settings.min_gap ?? 30) || 30));
  const s = sessionPivots(bars, variant, gap).at(-1);
  if (!s) return [];
  const tags: AxisTag[] = Object.entries(s.levels).map(([name, price]) => ({ price, color: colorOf(name, settings), text: `${name} ${fmt(price)}` }));
  if (settings.show_prev !== false) {
    tags.push({ price: s.source.high, color: PREV, text: `PDH ${fmt(s.source.high)}` });
    tags.push({ price: s.source.low, color: PREV, text: `PDL ${fmt(s.source.low)}` });
  }
  return tags;
}

export function pivotsIndicator(): IndicatorDescriptor {
  return {
    id: PIVOTS_ID,
    name: "Pivot levels",
    category: "Sessions",
    placement: "onchart",
    inputs,
    plots: [],
    calc(bars, settings, store) {
      store.axisTags = pivotTags(bars, settings);
      return {};
    },
    draws({ bars, settings }) {
      const variant = (["classic", "fibonacci", "camarilla"].includes(String(settings.variant)) ? settings.variant : "classic") as PivotVariant;
      const gap = Math.max(5, Math.min(600, Number(settings.min_gap ?? 30) || 30));
      const days = Math.max(1, Math.min(20, Math.floor(Number(settings.days ?? 3)) || 3));
      const all = sessionPivots(bars, variant, gap);
      const shown = all.slice(-days);
      const out: unknown[] = [];
      shown.forEach((s, i) => {
        const newest = i === shown.length - 1;
        const line = (price: number, color: string, style: "solid" | "dashed") => ({ kind: "line", from: { time: s.from, price }, to: { time: s.to, price }, color, lineWidth: 1, lineStyle: style }) as const;
        for (const [name, price] of Object.entries(s.levels)) {
          const color = colorOf(name, settings);
          out.push(line(price, color, name === "P" ? "solid" : "dashed"));
        }
        if (settings.show_prev !== false) {
          out.push(line(s.source.high, String(PREV), "dashed"));
          out.push(line(s.source.low, String(PREV), "dashed"));
        }
      });
      return out as never;
    },
  };
}

/** Registers the study once; a failure leaves the chart as it was. */
export function registerPivots(register: (d: IndicatorDescriptor) => void, has: (id: string) => boolean): void {
  try {
    if (!has(PIVOTS_ID)) register(pivotsIndicator());
  } catch (e) {
    console.warn("pivot levels study not registered:", (e as Error).message);
  }
}
