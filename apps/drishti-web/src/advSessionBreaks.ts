import type { IndicatorDescriptor, IndicatorInput } from "openalgo-charts";
import { sessionBreaks } from "@drishti/shared";
import { withAlpha } from "./advKillzones";

// Session breaks on the advanced chart: where each session opens (and, if switched on, where the last one closed), found from the candles themselves, so
// the overnight close of MCX, the daily break of NYMEX, weekends and holidays all show as they happened. Three marks that read on a dark chart: a solid
// vertical line, a shaded stripe on the session's first candle (the library's per-bar background, as the killzones use) and a small labelled arrow.
// A plain indicator of the library (it reads only the chart's bars); nothing to draw on a daily chart, where every candle is a session.

export const SESSION_BREAKS_ID = "drishti-session-breaks";

const OPEN = "#ffd54f";
const CLOSE = "#90a4ae";

const inputs: IndicatorInput[] = [
  { key: "show_open", type: "boolean", label: "Session open", default: true },
  { key: "color_open", type: "color", label: "Open colour", default: OPEN },
  { key: "show_close", type: "boolean", label: "Session close", default: false },
  { key: "color_close", type: "color", label: "Close colour", default: CLOSE },
  { key: "show_labels", type: "boolean", label: "Labels", default: true },
  { key: "min_gap", type: "number", label: "Shortest break (minutes)", default: 30, min: 5, max: 600, step: 5, tooltip: "A gap between two candles shorter than this is a quiet market, not a close" },
];

const minGapOf = (settings: Readonly<Record<string, unknown>>) => Math.max(5, Math.min(600, Number(settings.min_gap ?? 30) || 30));

export function sessionBreakIndicator(): IndicatorDescriptor {
  return {
    id: SESSION_BREAKS_ID,
    name: "Session breaks",
    category: "Sessions",
    placement: "onchart",
    inputs,
    plots: [],
    calc: () => ({}),
    draws({ bars, settings }) {
      const breaks = sessionBreaks(bars, minGapOf(settings));
      if (!breaks.length) return [];
      let lo = Infinity;
      let hi = -Infinity;
      for (const b of bars) {
        lo = Math.min(lo, b.low);
        hi = Math.max(hi, b.high);
      }
      // no extendLeft/extendRight: a vertical line with them did not draw in the library
      const line = (time: number, color: string) => ({ kind: "line", from: { time, price: lo }, to: { time, price: hi }, color, lineWidth: 1, lineStyle: "solid" }) as const;
      const out = [];
      for (const b of breaks) {
        if (settings.show_open !== false) out.push(line(b.openAt, String(settings.color_open ?? OPEN)));
        if (settings.show_close === true) out.push(line(b.closeAt, String(settings.color_close ?? CLOSE)));
      }
      return out as never;
    },
    // the first candle after each break (and the last one before it, when asked) shaded
    background({ bars, settings }) {
      const out: (string | null)[] = bars.map(() => null);
      const at = new Map(bars.map((b, i) => [b.time, i]));
      for (const b of sessionBreaks(bars, minGapOf(settings))) {
        const open = at.get(b.openAt);
        if (settings.show_open !== false && open !== undefined) out[open] = withAlpha(String(settings.color_open ?? OPEN), 0.35);
        const last = open === undefined ? undefined : open - 1;
        if (settings.show_close === true && last !== undefined && last >= 0) out[last] = withAlpha(String(settings.color_close ?? CLOSE), 0.3);
      }
      return out;
    },
    markerAnchor: "price",
    markers({ bars, settings }) {
      if (settings.show_labels === false) return [];
      const out: unknown[] = [];
      const at = new Map(bars.map((b, i) => [b.time, i]));
      for (const b of sessionBreaks(bars, minGapOf(settings))) {
        if (settings.show_open !== false) out.push({ time: b.openAt, position: "belowBar", shape: "arrowUp", size: "small", color: String(settings.color_open ?? OPEN), text: "Open" });
        const open = at.get(b.openAt);
        if (settings.show_close === true && open !== undefined && open > 0) out.push({ time: bars[open - 1].time, position: "aboveBar", shape: "arrowDown", size: "small", color: String(settings.color_close ?? CLOSE), text: "Close" });
      }
      return out as never;
    },
  };
}

/** Registers the study once; the library's functions are passed in so this file never imports the (lazy, heavy) library itself. A failure leaves the chart as it was. */
export function registerSessionBreaks(register: (d: IndicatorDescriptor) => void, has: (id: string) => boolean): void {
  try {
    if (!has(SESSION_BREAKS_ID)) register(sessionBreakIndicator());
  } catch (e) {
    console.warn("session breaks study not registered:", (e as Error).message);
  }
}
