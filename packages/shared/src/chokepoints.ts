// Daily vessel transits through the sea lanes oil and gas depend on (IMF PortWatch, free and keyless, built from ship-tracking data).
// Pure statistics over the daily counts, tested; the API fetches, the panel draws.

export const CHOKEPOINTS = [
  { id: "hormuz", name: "Strait of Hormuz", why: "About a fifth of the world's oil: Gulf exports to Asia" },
  { id: "babelmandeb", name: "Bab el-Mandeb Strait", why: "Red Sea entrance: Gulf and Asian cargoes to Suez and Europe" },
  { id: "suez", name: "Suez Canal", why: "Gulf and Asian crude and LNG to the Mediterranean" },
  { id: "malacca", name: "Malacca Strait", why: "Gulf crude into East Asia; the main Asian chokepoint" },
  { id: "capegood", name: "Cape of Good Hope", why: "Where cargoes go when Suez or the Red Sea is avoided" },
  { id: "bosporus", name: "Bosporus Strait", why: "Black Sea and Russian oil exports" },
] as const;
export type ChokepointId = (typeof CHOKEPOINTS)[number]["id"];

/** PortWatch's own name for each chokepoint, which is what the API filters on. */
export const CHOKEPOINT_PORTNAME: Record<ChokepointId, string> = {
  hormuz: "Strait of Hormuz",
  babelmandeb: "Bab el-Mandeb Strait",
  suez: "Suez Canal",
  malacca: "Malacca Strait",
  capegood: "Cape of Good Hope",
  bosporus: "Bosporus Strait",
};

export interface TransitDay {
  /** YYYY-MM-DD */
  date: string;
  tankers: number;
  vessels: number;
  /** deadweight tonnage of tankers (PortWatch "capacity_tanker") */
  tankerCapacity: number;
}

/** ArcGIS feature rows → days, oldest first. Rows without a date or a tanker count are skipped. */
export function parseTransits(json: any): TransitDay[] {
  const out: TransitDay[] = [];
  for (const f of json?.features ?? []) {
    const a = f?.attributes ?? {};
    const tankers = a.n_tanker == null ? NaN : Number(a.n_tanker); // Number(null) is 0: a missing count is not zero ships
    if (typeof a.date !== "string" || !Number.isFinite(tankers)) continue;
    out.push({ date: a.date.slice(0, 10), tankers, vessels: Number(a.n_total) || 0, tankerCapacity: Number(a.capacity_tanker) || 0 });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

const DAY = 86_400_000;
const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined);

/** Average tankers per day over the `days` calendar days ending on `end` (inclusive); undefined when fewer than half the days exist. */
export function averageTankers(days: TransitDay[], end: string, span: number): number | undefined {
  const to = at(end);
  const inRange = days.filter((d) => at(d.date) > to - span * DAY && at(d.date) <= to);
  return inRange.length >= span / 2 ? mean(inRange.map((d) => d.tankers)) : undefined;
}

export type Flow = "normal" | "reduced" | "disrupted" | "unknown";

export interface TransitSummary {
  /** date of the newest observation (the data runs a few days behind) */
  asOf: string;
  last: number;
  avg7: number | undefined;
  avg30: number | undefined;
  /** the same 30-day window one year earlier */
  avg30YearAgo: number | undefined;
  /** avg30 against the year-ago window, percent; negative = fewer ships */
  vsYearAgoPct: number | undefined;
  flow: Flow;
}

/** Flow against the same season a year ago: more than 30% below is "reduced", more than 70% below is "disrupted". */
export function flowOf(vsYearAgoPct: number | undefined): Flow {
  if (vsYearAgoPct === undefined) return "unknown";
  return vsYearAgoPct <= -70 ? "disrupted" : vsYearAgoPct <= -30 ? "reduced" : "normal";
}

export function summarizeTransits(days: TransitDay[]): TransitSummary | undefined {
  const newest = days[days.length - 1];
  if (!newest) return undefined;
  const yearAgoEnd = new Date(at(newest.date) - 365 * DAY).toISOString().slice(0, 10);
  const avg30 = averageTankers(days, newest.date, 30);
  const avg30YearAgo = averageTankers(days, yearAgoEnd, 30);
  const vsYearAgoPct = avg30 !== undefined && avg30YearAgo ? ((avg30 - avg30YearAgo) / avg30YearAgo) * 100 : undefined;
  return { asOf: newest.date, last: newest.tankers, avg7: averageTankers(days, newest.date, 7), avg30, avg30YearAgo, vsYearAgoPct, flow: flowOf(vsYearAgoPct) };
}

/** 7-day rolling average of tankers per day, one value per day from the 7th on: the line the panel draws. */
export function rollingTankers(days: TransitDay[], window = 7): number[] {
  return days.map((_, i) => (i + 1 < window ? undefined : mean(days.slice(i + 1 - window, i + 1).map((d) => d.tankers)))).filter((v): v is number => v !== undefined);
}
