// Consensus forecasts for the EIA and API weekly releases, from the event pages of Investing.com's economic calendar. Each page carries the event's
// history in its own HTML (Next.js state: about 100 occurrences, past and coming, with actual, forecast and previous), so one request gives two
// years of forecasts. This is a THIRD-PARTY, UNOFFICIAL consensus (Investing.com's terms forbid automated access): it is fetched a few times a day at
// most, stopped for good measure when the site answers anything but a page, labelled as Investing.com wherever a forecast from it is shown, and
// ranked below a figure typed in by the owner or recorded from Forex Factory. Pure, so the parsing is tested.

export type InvestingSeries = "eia_crude" | "eia_gasoline" | "eia_distillates" | "api_crude" | "eia_gas";

export interface InvestingPage {
  series: InvestingSeries;
  label: string;
  url: string;
}

/** The four event pages the owner named. Adding a series (gas storage, Cushing) is one more entry. */
export const INVESTING_PAGES: readonly InvestingPage[] = [
  { series: "eia_crude", label: "EIA crude oil inventories", url: "https://www.investing.com/economic-calendar/eia-crude-oil-inventories-75" },
  { series: "eia_gasoline", label: "EIA gasoline inventories", url: "https://www.investing.com/economic-calendar/gasoline-inventories-485" },
  { series: "eia_distillates", label: "EIA distillate stocks", url: "https://www.investing.com/economic-calendar/eia-weekly-distillates-stocks-917" },
  { series: "api_crude", label: "API weekly crude stock", url: "https://www.investing.com/economic-calendar/api-weekly-crude-stock-656" },
  { series: "eia_gas", label: "EIA natural gas storage", url: "https://www.investing.com/economic-calendar/natural-gas-storage-386" }, // Bcf, not million barrels
];

export interface InvestingOccurrence {
  occurrenceId: number;
  /** the scheduled release, epoch ms */
  at: number;
  /** million barrels (the pages' unit is `M`); absent when the page has no figure yet */
  forecast?: number;
  previous?: number;
  actual?: number;
  unit: string;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The occurrences of one event page, oldest first. Returns undefined when the page is not an event page (a block, a login wall or a layout change:
 * no state, or no occurrence list), so the caller can tell "no data" from "the page changed" and stop asking.
 */
export function parseInvestingEvent(html: string): InvestingOccurrence[] | undefined {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return undefined;
  let state: any;
  try {
    state = JSON.parse(m[1])?.props?.pageProps?.state?.economicCalendarEventStore;
  } catch {
    return undefined;
  }
  const raw = state?.occurrences;
  if (!Array.isArray(raw)) return undefined;
  const out: InvestingOccurrence[] = [];
  for (const o of raw) {
    const at = Date.parse(o?.occurrence_time);
    const id = num(o?.occurrence_id);
    if (!Number.isFinite(at) || id === undefined) continue;
    out.push({ occurrenceId: id, at, forecast: num(o.forecast), previous: num(o.previous), actual: num(o.actual), unit: typeof o.unit === "string" ? o.unit : "" });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A page that did not answer with an event page: what to tell the owner. */
export function investingProblem(status: number, html: string): string | undefined {
  if (status === 403 || status === 429 || status === 503) return `Investing.com answered HTTP ${status}: it is blocking automated requests`;
  if (status >= 400) return `Investing.com answered HTTP ${status}`;
  if (/just a moment|cf-chl|attention required|captcha/i.test(html.slice(0, 4000))) return "Investing.com served a bot check instead of the page";
  return undefined;
}

/**
 * When to look again. A page is read at most every six hours; in the ninety minutes before a release it is read at most every thirty minutes (the
 * consensus can move late); and never while the site has said no (`blockedUntil`). `nextRelease` is the next scheduled occurrence, epoch ms.
 */
export function shouldFetchInvesting(now: number, lastFetch: number | undefined, nextRelease: number | undefined, blockedUntil = 0): boolean {
  if (now < blockedUntil) return false;
  if (lastFetch === undefined) return true;
  const age = now - lastFetch;
  const nearRelease = nextRelease !== undefined && nextRelease - now <= 90 * 60_000 && nextRelease - now > -10 * 60_000;
  return age >= (nearRelease ? 30 * 60_000 : 6 * 3600_000);
}

/** How long to leave the site alone after it blocked us. */
export const INVESTING_BLOCK_MS = 12 * 3600_000;
