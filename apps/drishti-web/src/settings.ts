import { create } from "zustand";
import { persist } from "zustand/middleware";
import { instrument, type Timeframe } from "@drishti/shared";

export interface TvChannel {
  name: string;
  url: string;
}

export interface Settings {
  // appearance
  theme: "dark" | "light";
  density: "compact" | "comfortable";
  fontSize: number;
  colors: "green-red" | "red-green" | "blue-orange";
  // data & formatting
  locale: "en-IN" | "en-US";
  /** -1 = auto: each instrument's own tick precision */
  decimals: number;
  /** clock style for every time shown (news, quotes, chart axis) */
  clock: "12h" | "24h";
  defaultTf: Timeframe;
  flash: boolean;
  // workspace
  lockLayout: boolean;
  confirmClose: boolean;
  // live TV: user-added HLS (.m3u8) streams on top of the built-in list in TvWidget.tsx
  tvChannels: TvChannel[];
  // connection ("" = use env / dev proxy default)
  apiUrl: string;
  streamUrl: string;
}

export const DEFAULTS: Settings = {
  theme: "dark",
  density: "compact",
  fontSize: 13,
  colors: "green-red",
  locale: "en-IN",
  decimals: -1,
  clock: "12h",
  defaultTf: "1m",
  flash: true,
  lockLayout: false,
  confirmClose: false,
  tvChannels: [],
  apiUrl: "",
  streamUrl: "",
};

interface SettingsState extends Settings {
  open: boolean;
  set: (patch: Partial<Settings>) => void;
  setOpen: (open: boolean) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      open: false,
      set: (patch) => set(patch),
      setOpen: (open) => set({ open }),
      reset: () => set(DEFAULTS),
    }),
    {
      name: "drishti-settings",
      version: 2,
      // v2: real instruments have their own precision (NG 3 dp, MCX crude 0 dp), so reset decimals to auto
      migrate: (saved, version) => (version < 2 ? { ...(saved as object), decimals: -1 } : saved) as Settings,
      partialize: ({ open, set, setOpen, reset, ...rest }) => rest,
      // fill in settings added after the user's copy was saved
      merge: (saved, current) => ({ ...current, ...(saved as Partial<Settings>) }),
    },
  ),
);

/** Empty is allowed (means "use default"); otherwise must parse as a URL with one of the protocols. */
export function validateUrl(value: string, protocols: string[]): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return protocols.includes(url.protocol) ? null : `must start with ${protocols.map((p) => p + "//").join(" or ")}`;
  } catch {
    return "not a valid URL";
  }
}

export const apiUrl = () => useSettings.getState().apiUrl || import.meta.env.VITE_API_URL || "/api";
export const streamUrl = () =>
  useSettings.getState().streamUrl ||
  import.meta.env.VITE_STREAM_URL ||
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

/** Plain-HTTP endpoint on the stream service (e.g. /health). Dev default goes through the Vite `/stream` proxy. */
export function streamHttpUrl(path: string) {
  const custom = useSettings.getState().streamUrl || import.meta.env.VITE_STREAM_URL;
  if (!custom) return `/stream${path}`;
  const url = new URL(custom);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = path;
  return url.toString();
}

/** Theme, density, font size and up/down colours are CSS-driven via attributes on <html>. */
export function applyToDocument(s: Settings) {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.density = s.density;
  root.dataset.colors = s.colors;
  root.style.fontSize = `${s.fontSize}px`;
}

const formats = new Map<string, ReturnType<typeof buildFormat>>();

/** Cached per locale+decimals: Intl formatters are costly and prices re-render on every tick. */
export function makeFormat(locale: string, decimals: number) {
  const key = `${locale}|${decimals}`;
  if (!formats.has(key)) formats.set(key, buildFormat(locale, decimals));
  return formats.get(key)!;
}

function buildFormat(locale: string, decimals: number) {
  const price = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  return {
    price: (n: number | undefined) => (n === undefined ? "—" : price.format(n)),
    volume: (n: number | undefined) => (n === undefined ? "—" : compact.format(n)),
  };
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
type StampParts = "datetime" | "time" | "date";

/** Viewer-local date/time text: "20 Oct 2026, 10:42 pm IST" (12h) or "20 Oct 2026, 22:42 IST" (24h). Formatters cached. */
export function formatStamp(t: number, locale: string, clock: Settings["clock"], parts: StampParts = "datetime", timeZone?: string) {
  const key = `${locale}|${clock}|${parts}|${timeZone ?? ""}`;
  let f = dateFormats.get(key);
  if (!f) {
    const date: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" };
    const time: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: clock === "12h" ? "h12" : "h23" };
    f = new Intl.DateTimeFormat(locale, {
      ...(parts !== "time" ? date : {}),
      ...(parts !== "date" ? time : {}),
      ...(parts === "datetime" ? { timeZoneName: "short" } : {}),
      timeZone,
    });
    dateFormats.set(key, f);
  }
  return f.format(t);
}

/** Time formatters bound to the user's number format + 12/24h setting. */
export function useClock() {
  const locale = useSettings((s) => s.locale);
  const clock = useSettings((s) => s.clock);
  return {
    stamp: (t: number) => formatStamp(t, locale, clock, "datetime"),
    time: (t: number) => formatStamp(t, locale, clock, "time"),
  };
}

export const decimalsFor = (symbol: string | undefined, setting: number) =>
  setting >= 0 ? setting : (instrument(symbol ?? "")?.decimals ?? 2);

/** Formatters for a symbol: price precision follows the instrument unless the user fixed decimals. */
export function useFormat(symbol?: string) {
  const locale = useSettings((s) => s.locale);
  const decimals = useSettings((s) => s.decimals);
  return makeFormat(locale, decimalsFor(symbol, decimals));
}
