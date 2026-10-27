import type { SQL } from "bun";
import { lotUnits, replayAmdTrade, replayReportTrade, reportSignal, SENSITIVITY_R, summarizeReplay, type Bar, type ReplayParams, type ReplayReport, type ReplayRow } from "@drishti/shared";

/** The default parameters of the replay for a report: crude mini on the petroleum report, gas mini on the gas report, R = 0.5% of the entry price. */
export const defaultReplay = (report: ReplayParams["report"]): ReplayParams => ({
  report,
  entry: "release",
  underlying: report === "WPSR" ? "CRUDEOILM" : "NATGASMINI",
  rPct: 0.5,
  delayMin: 1,
  holdMin: 60,
  slip: report === "WPSR" ? 1 : 0.1,
  threshold: report === "WPSR" ? 3 : 5,
  since: "2026-04-25",
});

/**
 * Replay the report-day strategy over the one-minute candles we hold (`option_candles`, side FUT). The release list comes from `release_forecasts`
 * (surprise = the published change, else the page's actual, minus the forecast); the contract is the one with the most volume in the hour BEFORE the
 * release, so nothing after it is used; a release with no traded minute before it is skipped and counted, never filled with a guess.
 */
export async function runEiaReplay(sql: SQL, p: ReplayParams, withSensitivity = false): Promise<ReplayReport> {
  const units = lotUnits(`MCX:${p.underlying}`);
  if (!units) throw new Error(`unknown underlying ${p.underlying}`);
  const series = p.report === "WPSR" ? "eia_crude" : "eia_gas";
  const fc = (await sql`SELECT release_at, forecast, actual FROM release_forecasts WHERE series = ${series} AND release_at >= ${p.since}::timestamptz AND release_at < now() ORDER BY release_at`) as { release_at: Date; forecast: number | null; actual: number | null }[];
  const published: [number, number][] = [];
  if (p.report === "WPSR") {
    const rows = (await sql`SELECT a.official_release_at AS at, v.change FROM eia_report_arrivals a JOIN eia_report_values v ON v.event_id = a.event_id AND v.series_id = 'WPSR:T1:COMMERCIAL_EXCLUDING_SPR' WHERE a.official_release_at IS NOT NULL`) as { at: Date; change: number | null }[];
    for (const r of rows) if (r.change !== null) published.push([new Date(r.at).getTime(), Number(r.change)]);
  }
  const keys = ((await sql`SELECT key FROM option_contracts WHERE side = 'FUT' AND underlying = ${p.underlying}`) as { key: string }[]).map((r) => r.key);

  const bars = new Map<number, { key: string; bars: Bar[] } | undefined>();
  const barsAt = async (at: number) => {
    if (bars.has(at) || !keys.length) return bars.get(at);
    const rows = (await sql`SELECT key, extract(epoch FROM time)::int AS t, open, high, low, close, volume FROM option_candles WHERE key IN ${sql(keys)} AND time >= ${new Date(at - 3600_000)} AND time <= ${new Date(at + (p.holdMin + 10) * 60_000)} ORDER BY time`) as any[];
    const by = new Map<string, Bar[]>();
    const before = new Map<string, number>();
    for (const r of rows) {
      (by.get(r.key) ?? by.set(r.key, []).get(r.key)!).push({ time: r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume });
      if (r.t * 1000 < at) before.set(r.key, (before.get(r.key) ?? 0) + Number(r.volume));
    }
    const pick = [...before.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    bars.set(at, pick ? { key: pick, bars: by.get(pick)! } : undefined);
    return bars.get(at);
  };

  const run = async (rPct: number): Promise<ReplayRow[]> => {
    const out: ReplayRow[] = [];
    for (const f of fc) {
      const at = new Date(f.release_at).getTime();
      const actual = p.report === "WPSR" ? (published.find(([t]) => Math.abs(t - at) < 20 * 3600_000)?.[1] ?? f.actual) : f.actual;
      const surprise = f.forecast !== null && actual !== null && actual !== undefined ? actual - f.forecast : undefined;
      const found = await barsAt(at);
      const cfg = { rPct, delayMin: p.delayMin, holdMin: p.holdMin, slip: p.slip, units, lotsPerLeg: 1 };
      const side = reportSignal(surprise, p.threshold); // the surprise must reach the threshold whatever the entry, so the entries compare on the same releases
      const result =
        p.entry === "release" ? replayReportTrade(found?.bars ?? [], at / 1000, side, cfg) : replayAmdTrade(found?.bars ?? [], at / 1000, side, { ...cfg, direction: p.entry === "amd-sweep" ? "sweep" : "surprise" });
      out.push({ at, surprise, contract: found?.key, result });
    }
    return out;
  };

  const rows = await run(p.rPct);
  const sensitivity = withSensitivity ? await Promise.all(SENSITIVITY_R.map(async (rPct) => ({ rPct, summary: summarizeReplay((await run(rPct)).map((r) => r.result)) }))) : undefined;
  return { params: p, units, rows, summary: summarizeReplay(rows.map((r) => r.result)), sensitivity };
}
