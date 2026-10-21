import { useEffect, useMemo, useState } from "react";
import { fixedRiskLots, instrument, lotUnits, roundTrip, UPSTOX_MCX_RATES, type CostRates, type Side } from "@drishti/shared";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { useWidgetSymbol, type Widget } from "./workspace";

const KEY = "drishti-costs";
interface Saved {
  rates: CostRates;
  equity: number;
  riskPct: number;
}
const DEFAULTS: Saved = { rates: UPSTOX_MCX_RATES, equity: 500_000, riskPct: 1 };

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return s ? { ...DEFAULTS, ...s, rates: { ...UPSTOX_MCX_RATES, ...s.rates } } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const RATE_FIELDS: [keyof CostRates, string, string][] = [
  ["brokerageFlat", "Brokerage per order (₹)", "1"],
  ["cttFutures", "CTT, sell side (share of turnover)", "0.000001"],
  ["exchangeFutures", "MCX transaction charge", "0.000001"],
  ["sebi", "SEBI fee", "0.0000001"],
  ["stampFutures", "Stamp duty, buy side", "0.000001"],
  ["gst", "GST on brokerage, exchange, SEBI", "0.01"],
];

/** What an MCX futures trade costs on Upstox (gross to net) and how many lots a fixed risk allows. A calculator: it never places an order. */
export function CostsWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const inst = instrument(symbol);
  const units = lotUnits(symbol);
  const locale = useSettings((s) => s.locale);
  const live = useStore((s) => s.quotes[symbol]?.price);
  const [saved, setSaved] = useState<Saved>(load);
  const [side, setSide] = useState<Side>("buy");
  const [lots, setLots] = useState(1);
  const [entry, setEntry] = useState<number | "">("");
  const [exit, setExit] = useState<number | "">("");
  const [stop, setStop] = useState<number | "">("");

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      /* private window: the values just are not remembered */
    }
  }, [saved]);
  // a new instrument starts from its live price: entry there, exit and stop 0.5% either side
  useEffect(() => {
    setEntry("");
    setExit("");
    setStop("");
  }, [symbol]);
  const e = entry === "" ? live : entry;
  const x = exit === "" ? (e === undefined ? undefined : e * (side === "buy" ? 1.005 : 0.995)) : exit;
  const st = stop === "" ? (e === undefined ? undefined : e * (side === "buy" ? 0.995 : 1.005)) : stop;

  const nf = useMemo(() => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), [locale]);
  const rs = (v: number) => `${v < 0 ? "−" : ""}₹${nf.format(Math.abs(v))}`;

  if (inst?.exchange !== "MCX" || units === undefined) {
    return <p className="empty muted">Costs follow Upstox's MCX schedule. Link this panel to an MCX contract (NYMEX trades are not on Upstox).</p>;
  }
  const trip = e !== undefined && x !== undefined ? roundTrip("future", side, e, x, units, lots, saved.rates) : undefined;
  const sized = e !== undefined && st !== undefined ? fixedRiskLots({ side, equity: saved.equity, riskPct: saved.riskPct, entry: e, stop: st, units, rates: saved.rates }) : undefined;
  const num = (v: number | "", set: (n: number | "") => void) => (ev: React.ChangeEvent<HTMLInputElement>) => set(ev.target.value === "" ? "" : Number(ev.target.value));

  return (
    <div className="costs">
      <div className="costs-body" tabIndex={0} role="region" aria-label="Trade costs and position size">
        <p className="muted costs-head">
          {inst.name}: 1 lot = {inst.lot}. Round trip on Upstox, costs in rupees.
        </p>
        <div className="costs-form no-drag">
          <label>
            Side
            <select value={side} onChange={(ev) => setSide(ev.target.value as Side)}>
              <option value="buy">Long (buy, then sell)</option>
              <option value="sell">Short (sell, then buy)</option>
            </select>
          </label>
          <label>
            Lots
            <input type="number" min={1} step={1} value={lots} onChange={(ev) => setLots(Math.max(1, Math.floor(Number(ev.target.value) || 1)))} />
          </label>
          <label>
            Entry
            <input type="number" step="any" value={e === undefined ? "" : e} onChange={num(entry, setEntry)} />
          </label>
          <label>
            Exit
            <input type="number" step="any" value={x === undefined ? "" : Number(x.toFixed(inst.decimals))} onChange={num(exit, setExit)} />
          </label>
        </div>
        {trip && (
          <table>
            <tbody>
              <tr>
                <td>Gross P&amp;L</td>
                <td className={trip.gross >= 0 ? "up" : "down"}>{rs(trip.gross)}</td>
              </tr>
              {(
                [
                  ["Brokerage", trip.costs.brokerage],
                  ["CTT", trip.costs.ctt],
                  ["Exchange charge", trip.costs.exchange],
                  ["SEBI fee", trip.costs.sebi],
                  ["Stamp duty", trip.costs.stamp],
                  ["GST", trip.costs.gst],
                ] as const
              ).map(([label, v]) => (
                <tr key={label} className="muted">
                  <td>− {label}</td>
                  <td>{rs(v)}</td>
                </tr>
              ))}
              <tr className="costs-net">
                <td>Net P&amp;L</td>
                <td className={trip.net >= 0 ? "up" : "down"}>{rs(trip.net)}</td>
              </tr>
              <tr>
                <td title="Price points the trade must gain just to pay its costs">Breakeven move</td>
                <td>
                  {trip.breakevenPoints.toFixed(inst.decimals + 1)} points ({((trip.breakevenPoints / (e as number)) * 100).toFixed(3)}%)
                </td>
              </tr>
            </tbody>
          </table>
        )}
        <h2>Position size</h2>
        <div className="costs-form no-drag">
          <label>
            Equity (₹)
            <input type="number" min={0} step={1000} value={saved.equity} onChange={(ev) => setSaved({ ...saved, equity: Number(ev.target.value) })} />
          </label>
          <label>
            Risk per trade (%)
            <input type="number" min={0} step={0.1} value={saved.riskPct} onChange={(ev) => setSaved({ ...saved, riskPct: Number(ev.target.value) })} />
          </label>
          <label>
            Stop
            <input type="number" step="any" value={st === undefined ? "" : Number(st.toFixed(inst.decimals))} onChange={num(stop, setStop)} />
          </label>
        </div>
        {sized ? (
          <p className="costs-size">
            <strong>{sized.lots}</strong> lot{sized.lots === 1 ? "" : "s"} · risk budget {rs(sized.riskBudget)} · {rs(sized.riskPerLot)} per lot at the stop, costs included
            {sized.lots === 0 && <span className="down"> · even one lot exceeds the budget</span>}
          </p>
        ) : (
          <p className="muted costs-size">Put the stop on the losing side of the entry to size the trade.</p>
        )}
        <details>
          <summary>Cost rates</summary>
          <p className="muted costs-note">Upstox MCX schedule as published in its help centre and MCX's April 2026 circular. Upstox's pricing page shows 0.0026% for the exchange charge where its help centre shows 0.0021%: check a real contract note and edit here.</p>
          <div className="costs-form no-drag">
            {RATE_FIELDS.map(([k, label, step]) => (
              <label key={k}>
                {label}
                <input type="number" step={step} min={0} value={saved.rates[k]} onChange={(ev) => setSaved({ ...saved, rates: { ...saved.rates, [k]: Number(ev.target.value) } })} />
              </label>
            ))}
          </div>
          <button className="tf" onClick={() => setSaved({ ...saved, rates: UPSTOX_MCX_RATES })}>
            Reset rates
          </button>
        </details>
        <p className="muted costs-note">A calculator only: it never places an order. Margin is not included.</p>
      </div>
    </div>
  );
}
