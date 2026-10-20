import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Timeframe } from "@drishti/shared";

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
  decimals: number;
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
  decimals: 2,
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
      version: 1,
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

export function useFormat() {
  const locale = useSettings((s) => s.locale);
  const decimals = useSettings((s) => s.decimals);
  return makeFormat(locale, decimals);
}
