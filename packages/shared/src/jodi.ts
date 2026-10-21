// JODI Oil World (jodidata.org): monthly crude oil balances by country, reported by governments to the IEF, OPEC, IEA and others.
// Free CSV per year. India reports with a lag of several months, so every series carries its own latest month.
// Pure parsing and statistics, tested.

export const JODI_COUNTRIES = [
  { code: "IN", name: "India" },
  { code: "US", name: "United States" },
  { code: "CN", name: "China" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "JP", name: "Japan" },
] as const;
export type JodiCountry = (typeof JODI_COUNTRIES)[number]["code"];

/** The primary-data crude flows we show: JODI flow code → label, unit (thousand barrels per day for flows, thousand barrels for stocks). */
export const JODI_FLOWS = {
  INDPROD: { label: "Production", unit: "KBD" },
  TOTIMPSB: { label: "Imports", unit: "KBD" },
  TOTEXPSB: { label: "Exports", unit: "KBD" },
  REFINOBS: { label: "Refinery intake", unit: "KBD" },
  CLOSTLV: { label: "Closing stocks", unit: "KBBL" },
} as const;
export type JodiFlow = keyof typeof JODI_FLOWS;

export interface JodiPoint {
  country: string;
  /** YYYY-MM */
  month: string;
  flow: JodiFlow;
  value: number;
  /** JODI's data-quality code: 1 good, 2 fair, 3 less reliable (as published) */
  quality: number;
}

/** JODI primary CSV (REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE) → crude points for the wanted countries. "-" (not reported) and "x" (not applicable) are skipped, never read as zero. */
export function parseJodi(csv: string, countries: readonly string[]): JodiPoint[] {
  const out: JodiPoint[] = [];
  for (const line of csv.split("\n")) {
    const c = line.split(",");
    if (c.length < 7 || c[2] !== "CRUDEOIL" || !countries.includes(c[0])) continue;
    const flow = c[3] as JodiFlow;
    if (!(flow in JODI_FLOWS) || c[4] !== JODI_FLOWS[flow].unit || !/^\d{4}-\d{2}$/.test(c[1])) continue;
    const value = Number(c[5]);
    if (c[5] === "" || !Number.isFinite(value)) continue;
    out.push({ country: c[0], month: c[1], flow, value, quality: Number(c[6]) || 3 });
  }
  return out;
}

export interface JodiSeries {
  flow: JodiFlow;
  label: string;
  unit: string;
  /** oldest first */
  series: { month: string; value: number }[];
  latest?: { month: string; value: number; quality: number };
  /** change on the month before and on the same month a year earlier, percent; only when that month was reported */
  momPct?: number;
  yoyPct?: number;
}

const prevMonth = (m: string, back: number) => {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) - back;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const pct = (now: number, then: number | undefined) => (then ? ((now - then) / then) * 100 : undefined);

/** One country's flows, each with its latest reported month and the change against the month before and the year before. */
export function summarizeJodi(points: JodiPoint[], country: string): JodiSeries[] {
  return (Object.keys(JODI_FLOWS) as JodiFlow[]).map((flow) => {
    const mine = points.filter((p) => p.country === country && p.flow === flow).sort((a, b) => a.month.localeCompare(b.month));
    const byMonth = new Map(mine.map((p) => [p.month, p.value]));
    const last = mine[mine.length - 1];
    return {
      flow,
      label: JODI_FLOWS[flow].label,
      unit: JODI_FLOWS[flow].unit,
      series: mine.map((p) => ({ month: p.month, value: p.value })),
      latest: last && { month: last.month, value: last.value, quality: last.quality },
      momPct: last && pct(last.value, byMonth.get(prevMonth(last.month, 1))),
      yoyPct: last && pct(last.value, byMonth.get(prevMonth(last.month, 12))),
    };
  });
}
