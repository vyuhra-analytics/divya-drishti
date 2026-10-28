import { useMemo, useState } from "react";
import {
  barsPerYear,
  bootstrapCI,
  instrument,
  judge,
  lotUnits,
  runBacktest,
  sharpe,
  shiftTest,
  STRATEGIES,
  strategy,
  walkForward,
  type Bar,
  type BootstrapCI,
  type Params,
  type ShiftTest,
  type Verdict,
  type WalkFold,
  type BacktestResult,
} from "@drishti/shared";
import { apiUrl, useSettings } from "./settings";
import { sparkPoints } from "./spark";
import { EiaReplayView } from "./EiaReplayView";
import { TimeProfileView } from "./TimeProfileView";
import { useWidgetSymbol, type Widget } from "./workspace";

const TFS = ["5m", "15m", "1h", "1d"] as const;
const CAPITAL = 500_000;

interface Outcome {
  bars: number;
  from: number;
  to: number;
  result: BacktestResult;
  sharpe?: number;
  shift: ShiftTest;
  ci?: BootstrapCI;
  walk: WalkFold[];
  verdict: Verdict;
}

/** The strategy tester: price strategies on the provider history, the EIA report-day strategy replayed over the one-minute candles we hold, or the time-of-day profile of when the market is busy. */
export function BacktestWidget({ widget }: { widget: Widget }) {
  const [mode, setMode] = useState<"price" | "eia" | "time">("price");
  return (
    <div className="bt-modes">
      <div className="toolbar no-drag" role="group" aria-label="Test type">
        <button className={mode === "price" ? "tf active" : "tf"} onClick={() => setMode("price")}>
          Price strategies
        </button>
        <button className={mode === "eia" ? "tf active" : "tf"} onClick={() => setMode("eia")}>
          EIA report day
        </button>
        <button className={mode === "time" ? "tf active" : "tf"} onClick={() => setMode("time")}>
          Time of day
        </button>
      </div>
      {mode === "eia" ? <EiaReplayView /> : mode === "time" ? <TimeProfileView /> : <PriceTester widget={widget} />}
    </div>
  );
}

/** Strategy tester on the stored provider history with Upstox costs, validated against luck and overfitting. Research only: no orders. */
function PriceTester({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const inst = instrument(symbol);
  const units = lotUnits(symbol);
  const locale = useSettings((s) => s.locale);
  const [strategyId, setStrategyId] = useState(STRATEGIES[0].id);
  const def = strategy(strategyId)!;
  const [params, setParams] = useState<Params>(() => Object.fromEntries(def.params.map((p) => [p.key, p.value])));
  const [tf, setTf] = useState<(typeof TFS)[number]>("1h");
  const [lots, setLots] = useState(1);
  const [slippage, setSlippage] = useState(1);
  const [state, setState] = useState<"idle" | "running" | { error: string }>("idle");
  const [out, setOut] = useState<Outcome | null>(null);

  const nf = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
  const rs = (v: number) => `${v < 0 ? "−" : ""}₹${nf.format(Math.abs(v))}`;
  const day = (t: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(t * 1000);

  const pick = (id: string) => {
    setStrategyId(id);
    setParams(Object.fromEntries(strategy(id)!.params.map((p) => [p.key, p.value])));
    setOut(null);
  };

  const run = async () => {
    if (!units) return;
    setState("running");
    setOut(null);
    try {
      const res = await fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);
      if (!res.ok) throw new Error(`History unavailable (HTTP ${res.status})`);
      const bars: Bar[] = await res.json();
      if (bars.length < 100) throw new Error(`Only ${bars.length} bars of ${tf} history: too few to test. Try a shorter timeframe.`);
      await new Promise((r) => setTimeout(r, 30)); // let "Running…" paint before the heavy part
      const cfg = { units, lots, slippage };
      const signals = def.signals(bars, params);
      const result = runBacktest(bars, signals, cfg);
      const shift = shiftTest(bars, signals, cfg, result.metrics.net, 200, 1);
      const ci = bootstrapCI(result.trades, 1000, 1);
      const walk = walkForward(bars, def, cfg, 4);
      const py = barsPerYear(tf);
      setOut({ bars: bars.length, from: bars[0].time, to: bars[bars.length - 1].time, result, sharpe: py ? sharpe(result.equity, CAPITAL, py) : undefined, shift, ci, walk, verdict: judge(result.metrics, shift, ci, walk) });
      setState("idle");
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };

  if (inst?.exchange !== "MCX" || units === undefined) {
    return <p className="empty muted">The tester uses Upstox's MCX costs. Link this panel to an MCX contract (NYMEX history has contract-roll jumps and no cost model).</p>;
  }
  const m = out?.result.metrics;

  return (
    <div className="bt">
      <div className="bt-body" tabIndex={0} role="region" aria-label="Strategy tester">
        <div className="costs-form no-drag">
          <label>
            Strategy
            <select value={strategyId} onChange={(ev) => pick(ev.target.value)}>
              {STRATEGIES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Timeframe
            <select value={tf} onChange={(ev) => setTf(ev.target.value as (typeof TFS)[number])}>
              {TFS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Lots
            <input type="number" min={1} step={1} value={lots} onChange={(ev) => setLots(Math.max(1, Math.floor(Number(ev.target.value) || 1)))} />
          </label>
          <label title="Price points paid against you on every fill">
            Slippage (points)
            <input type="number" min={0} step="any" value={slippage} onChange={(ev) => setSlippage(Math.max(0, Number(ev.target.value) || 0))} />
          </label>
          {def.params.map((p) => (
            <label key={p.key}>
              {p.label}
              <input type="number" min={p.min} max={p.max} step={p.step} value={params[p.key]} onChange={(ev) => setParams({ ...params, [p.key]: Number(ev.target.value) })} />
            </label>
          ))}
        </div>
        <button className="tf active" onClick={run} disabled={state === "running"}>
          {state === "running" ? "Running…" : "Run test"}
        </button>
        {typeof state === "object" && <p className="empty muted">{state.error}</p>}

        {out && m && (
          <>
            <p className="muted bt-asof">
              {inst.name} · {out.bars} {tf} bars, {day(out.from)} to {day(out.to)} · fills at the next bar's open, Upstox costs and {slippage} point{slippage === 1 ? "" : "s"} slippage on every fill
            </p>
            <div className={`bt-verdict ${out.verdict.holdsUp ? "up" : "down"}`}>
              <strong>{out.verdict.holdsUp ? "Nothing here argues against it" : "Reasons for doubt"}</strong>
              <ul>
                {out.verdict.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
            <table>
              <tbody>
                <tr>
                  <td>Net P&amp;L</td>
                  <td className={m.net >= 0 ? "up" : "down"}>{rs(m.net)}</td>
                  <td className="muted">gross {rs(m.gross)}, costs {rs(m.costs)}</td>
                </tr>
                <tr>
                  <td>Trades</td>
                  <td>{m.trades}</td>
                  <td className="muted">win rate {(m.winRate * 100).toFixed(0)}%, average {rs(m.avgTrade)}</td>
                </tr>
                <tr>
                  <td>Profit factor</td>
                  <td>{Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞"}</td>
                  <td className="muted">Sharpe {out.sharpe === undefined ? "—" : out.sharpe.toFixed(2)} (on ₹{nf.format(CAPITAL)})</td>
                </tr>
                <tr>
                  <td>Max drawdown</td>
                  <td className="down">{rs(-m.maxDrawdown)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
            <svg className="bt-chart" viewBox="0 0 600 90" preserveAspectRatio="none" role="img" aria-label="Equity curve">
              <polyline points={sparkPoints(out.result.equity, 600, 90)} fill="none" stroke="var(--accent-fill)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
            <h2>Is it luck?</h2>
            <p>
              Random timing: <b>p = {out.shift.pValue.toFixed(2)}</b> <span className="muted">(share of {out.shift.runs} shifted copies that did as well; the typical shifted copy made {rs(out.shift.medianNet)})</span>
            </p>
            <p>
              Average trade, 95% interval:{" "}
              {out.ci ? (
                <b>
                  {rs(out.ci.meanLow)} to {rs(out.ci.meanHigh)}
                </b>
              ) : (
                <span className="muted">too few trades</span>
              )}
            </p>
            <h2>Walk-forward (tuned on the past, run on unseen bars)</h2>
            {out.walk.length === 0 ? (
              <p className="muted">Not enough bars.</p>
            ) : (
              <table className="bt-num">
                <thead>
                  <tr>
                    <th>Window</th>
                    <th>Parameters chosen</th>
                    <th>Past (tuned)</th>
                    <th>Unseen</th>
                  </tr>
                </thead>
                <tbody>
                  {out.walk.map((f, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td className="muted">{Object.entries(f.params).map(([k, v]) => `${k} ${v}`).join(", ")}</td>
                      <td>{rs(f.trainNet)}</td>
                      <td className={f.testNet >= 0 ? "up" : "down"}>
                        {rs(f.testNet)} <small className="muted">({f.testTrades} trades)</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        <p className="muted bt-note">History is the provider's single front contract (no roll jumps inside). Past results do not predict future ones; this is research, not advice, and no order is ever placed.</p>
      </div>
    </div>
  );
}
