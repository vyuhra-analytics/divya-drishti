import { useMemo, useState } from "react";
import { REPLAY_UNDERLYINGS, type ReplayEntry, type ReplayParams, type ReplayReport, type ReplayRow, type ReplaySummary } from "@drishti/shared";
import { apiUrl, useSettings } from "./settings";

const DEFAULTS: Record<ReplayParams["report"], Pick<ReplayParams, "underlying" | "slip" | "threshold">> = {
  WPSR: { underlying: "CRUDEOILM", slip: 1, threshold: 3 },
  WNGSR: { underlying: "NATGASMINI", slip: 0.1, threshold: 5 },
};
const ENTRY_NAMES: Record<ReplayEntry, string> = { release: "at the open after the release", "amd-sweep": "AMD against the sweep", "amd-surprise": "AMD with the surprise" };
const CRUDE = ["CRUDEOIL", "CRUDEOILM"];
const GAS = ["NATURALGAS", "NATGASMINI"];

/**
 * The EIA report-day strategy replayed over the one-minute candles we hold: a surprise at or beyond the threshold picks a side, two legs with a stop at
 * 1R and targets at +1R and +2R, Upstox costs and slippage on every fill. Research only: no order is placed. With a handful of trades it cannot tell
 * the rule from chance, and the panel says so.
 */
export function EiaReplayView() {
  const locale = useSettings((s) => s.locale);
  const [report, setReport] = useState<ReplayParams["report"]>("WPSR");
  const [underlying, setUnderlying] = useState<ReplayParams["underlying"]>("CRUDEOILM");
  const [entry, setEntry] = useState<ReplayEntry>("release");
  const [rPct, setRPct] = useState(0.5);
  const [delay, setDelay] = useState(1);
  const [hold, setHold] = useState(60);
  const [slip, setSlip] = useState(1);
  const [threshold, setThreshold] = useState(3);
  const [state, setState] = useState<"idle" | "running" | { error: string }>("idle");
  const [out, setOut] = useState<ReplayReport | null>(null);

  const nf = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
  const rs = (v: number) => `${v < 0 ? "−" : ""}₹${nf.format(Math.abs(v))}`;
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/New_York" });

  const pickReport = (r: ReplayParams["report"]) => {
    setReport(r);
    setUnderlying(DEFAULTS[r].underlying);
    setSlip(DEFAULTS[r].slip);
    setThreshold(DEFAULTS[r].threshold);
    setOut(null);
  };

  const run = async () => {
    setState("running");
    setOut(null);
    try {
      const q = new URLSearchParams({ report, entry, underlying, rpct: String(rPct), delay: String(delay), hold: String(hold), slip: String(slip), threshold: String(threshold), sensitivity: "1" });
      const res = await fetch(`${apiUrl()}/research/eia-replay?${q}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? `HTTP ${res.status}`);
      setOut(await res.json());
      setState("idle");
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };

  const s: ReplaySummary | undefined = out?.summary;
  const unit = out?.params.report === "WNGSR" ? "Bcf" : "MB";
  const skipped = s ? Object.entries(s.skipped) : [];

  return (
    <div className="bt">
      <div className="bt-body" tabIndex={0} role="region" aria-label="EIA report-day replay">
        <div className="costs-form no-drag">
          <label>
            Report
            <select value={report} onChange={(ev) => pickReport(ev.target.value as ReplayParams["report"])}>
              <option value="WPSR">Petroleum (Wed)</option>
              <option value="WNGSR">Natural gas (Thu)</option>
            </select>
          </label>
          <label>
            Contract
            <select value={underlying} onChange={(ev) => setUnderlying(ev.target.value as ReplayParams["underlying"])}>
              {REPLAY_UNDERLYINGS.filter((u) => (report === "WPSR" ? CRUDE : GAS).includes(u)).map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </label>
          <label title="How the trade is entered. At the open: right after the release, in the surprise's direction. AMD: wait for the first spike to sweep the pre-release range, then for a strong move that leaves a gap, and enter when price retraces into the gap (limit order; no retrace, no trade). The exits are the same.">
            Entry
            <select value={entry} onChange={(ev) => setEntry(ev.target.value as ReplayEntry)}>
              <option value="release">At the open after the release</option>
              <option value="amd-sweep">AMD: against the sweep, on the retrace</option>
              <option value="amd-surprise">AMD: with the surprise, on the retrace</option>
            </select>
          </label>
          <label title="R, the risk per trade, as a percentage of the entry price. The stop is 1R, the targets +1R and +2R.">
            R (% of price)
            <input type="number" min={0.05} max={5} step="any" value={rPct} onChange={(ev) => setRPct(Number(ev.target.value) || 0.5)} />
          </label>
          <label title={`The surprise (actual minus forecast) that allows a side, in ${report === "WPSR" ? "million barrels" : "Bcf"}`}>
            Surprise at least
            <input type="number" min={0} step="any" value={threshold} onChange={(ev) => setThreshold(Math.max(0, Number(ev.target.value) || 0))} />
          </label>
          <label title="Minutes after the release before entering (the open of the first traded minute from then)">
            Entry after (min)
            <input type="number" min={0} max={30} step={1} value={delay} onChange={(ev) => setDelay(Math.max(0, Math.min(30, Math.floor(Number(ev.target.value) || 0))))} />
          </label>
          <label title="Minutes the trade is held at most; what is left then closes at the last price">
            Hold (min)
            <input type="number" min={5} max={240} step={5} value={hold} onChange={(ev) => setHold(Math.max(5, Math.min(240, Math.floor(Number(ev.target.value) || 60))))} />
          </label>
          <label title="Price points paid against you on every market fill">
            Slippage (points)
            <input type="number" min={0} step="any" value={slip} onChange={(ev) => setSlip(Math.max(0, Number(ev.target.value) || 0))} />
          </label>
        </div>
        <button className="tf active" onClick={run} disabled={state === "running"}>
          {state === "running" ? "Running…" : "Run replay"}
        </button>
        {typeof state === "object" && <p className="empty muted">{state.error}</p>}

        {out && s && (
          <>
            <p className="muted bt-asof">
              {out.params.underlying} ({out.units} units a lot), entry {ENTRY_NAMES[out.params.entry]}, {out.rows.length} releases since {out.params.since} · one lot a leg, two legs · Upstox costs and {out.params.slip} point{out.params.slip === 1 ? "" : "s"} slippage on every market fill
            </p>
            <div className={`bt-verdict ${s.trades >= 30 ? "up" : "down"}`}>
              <strong>{s.trades >= 30 ? `${s.trades} trades` : `Only ${s.trades} trade${s.trades === 1 ? "" : "s"}: this cannot separate the rule from chance`}</strong>
              <ul>
                <li>About 30 trades is the least that says anything; a real test needs the ten years of one-minute prices we do not hold yet.</li>
                {skipped.map(([why, n]) => (
                  <li key={why}>
                    {n} release{n === 1 ? "" : "s"} skipped: {why}
                  </li>
                ))}
              </ul>
            </div>
            {s.trades > 0 && (
              <table>
                <tbody>
                  <tr>
                    <td>Net P&amp;L</td>
                    <td className={s.netTotal >= 0 ? "up" : "down"}>{rs(s.netTotal)}</td>
                    <td className="muted">
                      gross {rs(s.grossTotal)}, costs {rs(s.costsTotal)}
                    </td>
                  </tr>
                  <tr>
                    <td>Trades</td>
                    <td>{s.trades}</td>
                    <td className="muted">
                      won {s.winners} ({((s.winRate ?? 0) * 100).toFixed(0)}%), average {(s.avgNetR ?? 0).toFixed(2)}R
                    </td>
                  </tr>
                  <tr>
                    <td>Profit factor</td>
                    <td>{s.profitFactor === undefined ? "—" : s.profitFactor.toFixed(2)}</td>
                    <td className="muted">
                      long {s.bySide.long.trades} ({rs(s.bySide.long.net)}), short {s.bySide.short.trades} ({rs(s.bySide.short.net)})
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
            <h2>Each release</h2>
            <table className="bt-num ef-table">
              <thead>
                <tr>
                  <th>Release (New York)</th>
                  <th>Surprise ({unit})</th>
                  <th>Side</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {[...out.rows].reverse().map((r: ReplayRow) => (
                  <tr key={r.at}>
                    <td>{day(r.at)}</td>
                    <td>{r.surprise === undefined ? "—" : `${r.surprise > 0 ? "+" : ""}${r.surprise.toFixed(2)}`}</td>
                    {typeof r.result === "string" ? (
                      <td colSpan={2} className="muted">
                        {r.result}
                      </td>
                    ) : (
                      <>
                        <td>{r.result.side}</td>
                        <td className={r.result.net >= 0 ? "up" : "down"} title={`entry ${r.result.entry.toFixed(1)}; ${r.result.legs.map((l) => `${l.reason} ${l.r >= 0 ? "+" : ""}${l.r.toFixed(1)}R`).join(", ")}; costs ${rs(r.result.costs)}`}>
                          {rs(r.result.net)} <small className="muted">({r.result.netR.toFixed(2)}R)</small>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {out.sensitivity && (
              <>
                <h2>How much does R matter?</h2>
                <table className="bt-num">
                  <thead>
                    <tr>
                      <th>R</th>
                      <th>Trades</th>
                      <th>Won</th>
                      <th>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {out.sensitivity.map((x) => (
                      <tr key={x.rPct}>
                        <td>{x.rPct}%</td>
                        <td>{x.summary.trades}</td>
                        <td>{x.summary.winners}</td>
                        <td className={x.summary.netTotal >= 0 ? "up" : "down"}>{rs(x.summary.netTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted">To read how sensitive the answer is, not to pick the best R: choosing it after seeing the results would only fit the noise.</p>
              </>
            )}
          </>
        )}
        <p className="muted bt-note">The contract is the one with the most volume in the hour before the release. Surprise = the published change minus the Investing.com forecast. Past results do not predict future ones; this is research, not advice, and no order is ever placed.</p>
      </div>
    </div>
  );
}
