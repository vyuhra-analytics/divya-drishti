import type { Bar, IndicatorDescriptor, IndicatorInput, IndicatorSettings } from "openalgo-charts";
import { istWindow, LONDON_OPEN_WINDOW, po3Sweeps, sessionLevels, toIst, zoneAt, zoneDays, ZONES, type ZoneId } from "@drishti/shared";

// ICT killzones on the advanced chart: the five usual windows (defined in New York time, labelled in Indian time) shaded behind the candles, the New York day's midnight open, and the
// range of the Asian window that just ended. A plain indicator of the library (no data of its own: it reads the chart's bars), so it works on every
// symbol and timeframe up to 1 hour. Killzones are a trading convention, not exchange rules; the levels are drawn only where the bars support them
// (see sessionLevels: an MCX chart has no Asian range, and an hourly MCX chart no midnight open). Power of 3 markers (shared po3.ts): a London sweep of
// the Asian range that closes back inside, marked on the confirming bar (red arrow down = a swept high, green arrow up = a swept low); it needs the range.

export const KILLZONES_ID = "drishti-killzones";

const COLORS: Record<ZoneId, string> = { asian: "#78909c", london: "#42a5f5", nyam: "#ffa726", lclose: "#ab47bc", nypm: "#66bb6a" };
const ALPHA = 0.14;
const NOW = () => Math.floor(Date.now() / 1000);

/** "#rrggbb" to rgba(): the library's shading takes a CSS colour per bar. Anything that is not a six-digit hex is used as it is. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const on = (s: Readonly<IndicatorSettings>, key: string) => s[key] !== false;
const londonOpen = (s: Readonly<IndicatorSettings>) => s.london_open === true;
const enabled = (s: Readonly<IndicatorSettings>): ZoneId[] => ZONES.filter((z) => on(s, `show_${z.id}`)).map((z) => z.id);

const inputs: IndicatorInput[] = [
  ...ZONES.flatMap<IndicatorInput>((z) => [
    { key: `show_${z.id}`, type: "boolean", label: `${z.label} (${istWindow(z, NOW())} today; ${hhmm(z.from)}-${hhmm(z.to)} NY)`, default: true, group: "Killzones" },
    { key: `color_${z.id}`, type: "color", label: `${z.label} colour`, default: COLORS[z.id], group: "Killzones" },
  ]),
  { key: "london_open", type: "boolean", label: `London zone on the London cash open (07:00-10:00 London = ${istWindow(LONDON_OPEN_WINDOW, NOW(), "london")} today; off = the New York clock)`, default: false, group: "Killzones" },
  { key: "show_midnight", type: "boolean", label: `Midnight open (00:00 NY = ${hhmm(toIst(0, NOW()))} IST today)`, default: true, group: "Levels" },
  { key: "show_asia", type: "boolean", label: "Asian range (needs bars covering 20:00-24:00 NY)", default: true, group: "Levels" },
  { key: "show_po3", type: "boolean", label: "Power of 3 sweep markers (London sweep of the Asian range, then a close back inside)", default: true, group: "Levels" },
  { key: "box_days", type: "number", label: "Zone boxes for the latest days (high, low, range, average; 0 = none)", default: 2, min: 0, max: 10, step: 1, group: "Levels" },
];

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** a drawn box's window as Indian time on its own day (London's own clock when that zone is anchored to the London open) */
function boxWindow(id: string, sec: number, ldn: boolean): string {
  if (id === "london" && ldn) return istWindow(LONDON_OPEN_WINDOW, sec, "london");
  const z = ZONES.find((x) => x.id === id);
  return z ? istWindow(z, sec) : "";
}

export function killzoneIndicator(): IndicatorDescriptor {
  return {
    id: KILLZONES_ID,
    name: "ICT killzones",
    category: "Sessions (ICT)",
    placement: "onchart",
    inputs,
    plots: [
      { key: "midnight", type: "line", title: "Midnight open (00:00 NY)", style: { color: "#ffb300", lineWidth: 1 } as never },
      { key: "asiaHigh", type: "line", title: "Asian high", style: { color: "#78909c", lineWidth: 1 } as never },
      { key: "asiaLow", type: "line", title: "Asian low", style: { color: "#78909c", lineWidth: 1 } as never },
    ],
    calc(bars: readonly Bar[], settings) {
      const lv = sessionLevels(bars);
      const blank = bars.map(() => null);
      return {
        midnight: on(settings, "show_midnight") ? lv.midnight : blank,
        asiaHigh: on(settings, "show_asia") ? lv.asiaHigh : blank,
        asiaLow: on(settings, "show_asia") ? lv.asiaLow : blank,
      };
    },
    draws({ bars, settings }) {
      const n = Math.max(0, Math.min(10, Math.floor(Number(settings.box_days ?? 2))));
      if (!n) return [];
      const only = enabled(settings);
      const all = zoneDays(bars, { londonOpen: londonOpen(settings) }).filter((z) => z.killzone && only.includes(z.window as ZoneId));
      const last = new Set([...new Set(all.map((z) => z.day))].slice(-n));
      const f = (v: number) => String(Number(v.toFixed(2)));
      return all
        .filter((z) => last.has(z.day))
        .map((z) => {
          const color = String(settings[`color_${z.window}`] ?? COLORS[z.window as ZoneId]);
          return { kind: "box", from: { time: z.start, price: z.high }, to: { time: z.end, price: z.low }, color, fillColor: color, opacity: 0.05, lineWidth: 1, text: [`${z.label}  ${boxWindow(z.window, z.start, londonOpen(settings))}`, `H ${f(z.high)}  L ${f(z.low)}`, `Range ${f(z.range)}  Avg ${f(z.average)}`].join("\n"), fontSize: 10, verticalAlign: "top", align: "left" } as const;
        }) as never;
    },
    markerAnchor: "price",
    markers({ bars, settings }) {
      if (!on(settings, "show_po3")) return [];
      return po3Sweeps(bars, { londonOpen: londonOpen(settings) }).map((e) => ({
        time: e.confirmAt,
        position: e.bias === "bearish" ? "aboveBar" : "belowBar",
        shape: e.bias === "bearish" ? "arrowDown" : "arrowUp",
        size: "small",
        color: e.bias === "bearish" ? "#ef5350" : "#26a69a",
        text: e.bias === "bearish" ? "PO3 swept high" : "PO3 swept low",
      })) as never;
    },
    background({ bars, settings }) {
      const only = enabled(settings);
      return bars.map((b) => {
        const z = zoneAt(b.time, only, londonOpen(settings));
        return z ? withAlpha(String(settings[`color_${z}`] ?? COLORS[z]), ALPHA) : null;
      });
    },
  };
}

/** Registers the study once; the library's functions are passed in so this file never imports the (lazy, heavy) library itself. A failure leaves the chart as it was. */
export function registerKillzones(register: (d: IndicatorDescriptor) => void, has: (id: string) => boolean): void {
  try {
    if (!has(KILLZONES_ID)) register(killzoneIndicator());
  } catch (e) {
    console.warn("killzones study not registered:", (e as Error).message);
  }
}
