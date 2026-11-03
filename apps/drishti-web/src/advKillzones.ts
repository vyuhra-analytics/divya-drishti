import type { Bar, IndicatorDescriptor, IndicatorInput, IndicatorSettings } from "openalgo-charts";
import type { AxisTag } from "./advAxisTags";
import { barSeconds, dayLevels, istWindow, LONDON_OPEN_WINDOW, po3Sweeps, sessionLevels, toIst, zoneAt, zoneDays, ZONES, type ZoneId } from "@drishti/shared";

// ICT killzones on the advanced chart: the five usual windows (defined in New York time, labelled in Indian time) shaded behind the candles, the New York day's midnight open, and the
// range of the Asian window that just ended. A plain indicator of the library (no data of its own: it reads the chart's bars), so it works on every
// symbol and timeframe up to 1 hour. Killzones are a trading convention, not exchange rules; the levels are drawn only where the bars support them
// (see sessionLevels: an MCX chart has no Asian range, and an hourly MCX chart no midnight open). Power of 3 markers (shared po3.ts): a London sweep of
// the Asian range that closes back inside, marked on the confirming bar (red arrow down = a swept high, green arrow up = a swept low); it needs the range.

export const KILLZONES_ID = "drishti-killzones";

/** short zone names for the price-axis tags: the axis column has a fixed width and a longer tag is shrunk until it cannot be read */
const SHORT: Record<ZoneId, string> = { asian: "ASIA", london: "LDN", nyam: "NYAM", lclose: "LCL", nypm: "NYPM" };
const COLORS: Record<ZoneId, string> = { asian: "#78909c", london: "#42a5f5", nyam: "#ffa726", lclose: "#ab47bc", nypm: "#66bb6a" };
const ALPHA = 0.14;
/** how many candles past the newest the level name plates are anchored, so they sit in the free space beside the price axis */
const LABEL_BARS = 2; // (only used for the plates, which advAxisTags.ts replaces)
const TODAY = "#4dd0e1";
const PREV = "#90a4ae";
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
  { key: "show_day_levels", type: "boolean", label: "High and low of today and of the previous day (drawn from the start of each day, not across the chart)", default: true, group: "Levels" },
  { key: "extend_prev", type: "boolean", label: "Run the previous day's high and low on through today", default: true, group: "Levels" },
  { key: "color_today", type: "color", label: "Today's high and low colour", default: TODAY, group: "Levels" },
  { key: "color_prev", type: "color", label: "Previous day's high and low colour", default: PREV, group: "Levels" },
  { key: "zone_levels", type: "boolean", label: "High and low of each killzone, previous day and today (lines from the zone's start, on through the chart)", default: true, group: "Levels" },
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

/** A readable name plate that sits just above its anchor (a thin box of the line's own colour hid its text). */
const plate = (text: string, time: number, price: number, color: string, align: "left" | "right") => ({ kind: "label", at: { time, price }, text, color, textColor: "#ffffff", fontSize: 10, align, verticalAlign: "bottom" }) as const;

const fmt2 = (v: number) => String(Number(v.toFixed(2)));

/** Today's and the previous day's high and low: flat lines that start at the day's first candle (not across the whole chart), each with a small price label. */
export function dayLines(bars: readonly Bar[], settings: Readonly<IndicatorSettings>): unknown[] {
  if (!on(settings, "show_day_levels")) return [];
  const d = dayLevels(bars);
  if (!d) return [];
  const today = String(settings.color_today ?? TODAY);
  const prev = String(settings.color_prev ?? PREV);
  const tail = bars[bars.length - 1].time + barSeconds(bars) * LABEL_BARS;
  const prevTo = on(settings, "extend_prev") ? d.today.to : d.previous.to;
  const out: unknown[] = [];
  const level = (label: string, price: number, from: number, to: number, color: string, style: "solid" | "dashed") => {
    out.push({ kind: "line", from: { time: from, price }, to: { time: to, price }, color, lineWidth: 1, lineStyle: style });
    out.push(plate(`${label} ${fmt2(price)}`, tail, price, color, "right"));
  };
  level("PDH", d.previous.high, d.previous.from, prevTo, prev, "dashed");
  level("PDL", d.previous.low, d.previous.from, prevTo, prev, "dashed");
  level("DH", d.today.high, d.today.from, d.today.to, today, "solid");
  level("DL", d.today.low, d.today.from, d.today.to, today, "solid");
  return out;
}

/** Each enabled killzone's high and low for the previous New York day and today: flat lines from the zone's start to the newest candle, in the zone's colour (today's solid, the previous day's dashed). */
export function zoneLines(bars: readonly Bar[], settings: Readonly<IndicatorSettings>): unknown[] {
  if (!on(settings, "zone_levels")) return [];
  const tf = barSeconds(bars);
  if (!tf) return [];
  const only = enabled(settings);
  const all = zoneDays(bars, { londonOpen: londonOpen(settings) }).filter((z) => z.killzone && only.includes(z.window as ZoneId));
  const days = [...new Set(all.map((z) => z.day))].sort().slice(-2);
  const end = bars[bars.length - 1].time + tf;
  const out: unknown[] = [];
  for (const z of all.filter((x) => days.includes(x.day))) {
    const color = String(settings[`color_${z.window}`] ?? COLORS[z.window as ZoneId]);
    const style = z.day === days[days.length - 1] ? "solid" : "dashed";
    const tag = days.length > 1 && z.day === days[0] ? "P " : "";
    for (const [name, price] of [["H", z.high], ["L", z.low]] as const) {
      out.push({ kind: "line", from: { time: z.start, price }, to: { time: end, price }, color, lineWidth: 1, lineStyle: style });
      out.push(plate(`${tag}${SHORT[z.window as ZoneId]} ${name}`, end + tf * LABEL_BARS, price, color, "right"));
    }
  }
  return out;
}

type Drawn = { kind: "line" | "label"; at?: { price: number }; color: string; text?: string };
/** Every level line and its name plate, in one list. The names are shown on the price axis (advAxisTags.ts), so `draws` keeps only the lines. */
function levelDrawings(bars: readonly Bar[], settings: Readonly<IndicatorSettings>): Drawn[] {
  return [...dayLines(bars, settings), ...zoneLines(bars, settings)] as Drawn[];
}

/** The level names as price-axis tags. */
export function killzoneTags(bars: readonly Bar[], settings: Readonly<IndicatorSettings>): AxisTag[] {
  return levelDrawings(bars, settings).flatMap((d) => (d.kind === "label" && d.at && d.text ? [{ price: d.at.price, color: d.color, text: d.text }] : []));
}

function zoneBoxes(bars: readonly Bar[], settings: Readonly<IndicatorSettings>): unknown[] {
  const n = Math.max(0, Math.min(10, Math.floor(Number(settings.box_days ?? 2))));
  if (!n) return [];
  const only = enabled(settings);
  const all = zoneDays(bars, { londonOpen: londonOpen(settings) }).filter((z) => z.killzone && only.includes(z.window as ZoneId));
  const last = new Set([...new Set(all.map((z) => z.day))].slice(-n));
  const f = fmt2;
  return all
    .filter((z) => last.has(z.day))
    .flatMap((z) => {
      const color = String(settings[`color_${z.window}`] ?? COLORS[z.window as ZoneId]);
      const text = [`${z.label}  ${boxWindow(z.window, z.start, londonOpen(settings))}`, `H ${f(z.high)}  L ${f(z.low)}`, `Range ${f(z.range)}  Avg ${f(z.average)}`].join("\n");
      return [
        { kind: "box", from: { time: z.start, price: z.high }, to: { time: z.end, price: z.low }, color, fillColor: color, opacity: 0.05, lineWidth: 1 },
        plate(text, z.start, z.high, color, "left"), // the details sit on top of the box, not inside it
      ];
    });
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
    calc(bars: readonly Bar[], settings, store) {
      store.axisTags = killzoneTags(bars, settings);
      const lv = sessionLevels(bars);
      const blank = bars.map(() => null);
      return {
        midnight: on(settings, "show_midnight") ? lv.midnight : blank,
        asiaHigh: on(settings, "show_asia") ? lv.asiaHigh : blank,
        asiaLow: on(settings, "show_asia") ? lv.asiaLow : blank,
      };
    },
    draws({ bars, settings }) {
      return [...levelDrawings(bars, settings).filter((d) => d.kind === "line"), ...zoneBoxes(bars, settings)] as never;
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
