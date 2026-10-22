import { useEffect, useMemo, useRef, useState } from "react";
import { BROKERS, brokerById, compareBrokers, fixedRiskLots, instrument, legCosts, lotUnits, matchBroker, normalizeRates, roundTrip, UPSTOX_MCX_RATES, type CostRates, type Kind, type Side, type Verification } from "@drishti/shared";
import { paperCall } from "./paperClient";
import { apiUrl, useSettings } from "./settings";
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
    return s ? { ...DEFAULTS, ...s, rates: normalizeRates(s.rates) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const RATE_FIELDS: [keyof CostRates, string, string][] = [
  ["brokerageFlat", "Brokerage per order (₹)", "1"],
  ["brokeragePctFutures", "Brokerage, futures: share of turnover; the lower of this and the flat amount (0 = flat only)", "0.0001"],
  ["brokeragePctOptions", "Brokerage, options: share of turnover; the lower of this and the flat amount (0 = flat only)", "0.0001"],
  ["cttFutures", "CTT, sell side (share of turnover)", "0.000001"],
  ["exchangeFutures", "MCX transaction charge", "0.000001"],
  ["sebi", "SEBI fee", "0.0000001"],
  ["stampFutures", "Stamp duty, buy side", "0.000001"],
  ["gst", "GST on brokerage, exchange, SEBI", "0.01"],
];

const VERIFICATION: Record<Verification, string> = {
  api: "checked against the broker's own calculation",
  published: "from the broker's published pricing",
  unverified: "UNVERIFIED: third-party sites only",
  custom: "your own rates",
};

/** What an MCX futures trade costs at the broker you pick (gross to net) and how many lots a fixed risk allows. A calculator: it never places an order. */
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
  const [cmpKind, setCmpKind] = useState<Kind>("future");
  const [upCheck, setUpCheck] = useState<{ text: string; brokerage?: number; differs?: boolean } | null>(null);

  // the server charges paper trades with these rates: send a change there (not the untouched defaults on first render)
  const firstRates = useRef(true);
  useEffect(() => {
    if (firstRates.current) {
      firstRates.current = false;
      return;
    }
    const id = setTimeout(() => void paperCall("/rates", "PUT", saved.rates), 800);
    return () => clearTimeout(id);
  }, [saved.rates]);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      /* private window: the values just are not remembered */
    }
  }, [saved]);
  // Upstox's own charge calculation for this leg (entry side, our front month, the price in the Entry box or the live price), beside what our rates give
  const checkUpstox = async () => {
    const price = typeof entry === "number" ? entry : live;
    if (!price || !units) return setUpCheck({ text: "Enter a price (or wait for a live quote) first." });
    setUpCheck({ text: "Asking Upstox…" });
    try {
      const res = await fetch(`${apiUrl()}/costs/check?symbol=${encodeURIComponent(symbol)}&kind=future&side=${side}&price=${price}&lots=${lots}`);
      const body = await res.json();
      if (!res.ok) return setUpCheck({ text: String(body?.message ?? `Upstox check failed (${res.status})`) });
      const mine = legCosts("future", side, price, units, lots, saved.rates).total;
      const up = body.upstox;
      const diff = mine - up.total;
      setUpCheck({
        text: `Upstox charges ₹${up.total.toFixed(2)} for this leg (brokerage ₹${up.brokerage}); your rates give ₹${mine.toFixed(2)}${Math.abs(diff) <= 1 ? ": they agree." : `: ${diff > 0 ? "₹" + diff.toFixed(2) + " more" : "₹" + (-diff).toFixed(2) + " less"} than Upstox.`}`,
        brokerage: up.brokerage,
        differs: Math.abs(diff) > 1 && up.brokerage !== saved.rates.brokerageFlat,
      });
    } catch {
      setUpCheck({ text: "Could not reach the API." });
    }
  };
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
    return <p className="empty muted">Costs follow the MCX schedule and your broker's brokerage. Link this panel to an MCX contract (NYMEX trades are not on Upstox).</p>;
  }
  const trip = e !== undefined && x !== undefined ? roundTrip("future", side, e, x, units, lots, saved.rates) : undefined;
  const broker = matchBroker(saved.rates); // undefined once a rate has been edited: the rates are then your own
  const compare = e !== undefined && x !== undefined ? compareBrokers(cmpKind, side, e, x, units, lots) : [];
  const sized = e !== undefined && st !== undefined ? fixedRiskLots({ side, equity: saved.equity, riskPct: saved.riskPct, entry: e, stop: st, units, rates: saved.rates }) : undefined;
  const num = (v: number | "", set: (n: number | "") => void) => (ev: React.ChangeEvent<HTMLInputElement>) => set(ev.target.value === "" ? "" : Number(ev.target.value));

  return (
    <div className="costs">
      <div className="costs-body" tabIndex={0} role="region" aria-label="Trade costs and position size">
        <p className="muted costs-head">
          {inst.name}: 1 lot = {inst.lot}. Round trip at {broker?.name ?? "your own rates"}, costs in rupees.
        </p>
        <div className="costs-form no-drag">
          <label>
            Broker
            <select
              aria-label="Broker"
              value={broker?.id ?? "custom"}
              onChange={(ev) => {
                const b = brokerById(ev.target.value);
                if (b && b.id !== "custom") setSaved({ ...saved, rates: b.rates });
              }}
            >
              {BROKERS.filter((b) => b.id !== "custom").map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              {!broker && <option value="custom">Custom (edited)</option>}
            </select>
          </label>
        </div>
        <p className={broker?.verification === "unverified" ? "costs-note down" : "muted costs-note"} title={broker?.source}>
          {broker ? `${VERIFICATION[broker.verification]}, read ${broker.checkedOn}. ${broker.note ?? ""}` : "Your own rates: edited from a broker's. Pick a broker above to go back to its published rates."}
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
        {trip && (
          <>
            <h2>Same trade at each broker</h2>
            <div className="costs-form no-drag">
              <label>
                Treat Entry and Exit as
                <select aria-label="Compare as" value={cmpKind} onChange={(ev) => setCmpKind(ev.target.value as Kind)}>
                  <option value="future">a futures price</option>
                  <option value="option">an option premium</option>
                </select>
              </label>
            </div>
            <table aria-label="Costs by broker">
              <thead>
                <tr>
                  <th>Broker</th>
                  <th>Costs</th>
                  <th>Net</th>
                  <th title="Price points the trade must gain just to pay its costs">Breakeven</th>
                </tr>
              </thead>
              <tbody>
                {compare.map((c) => (
                  <tr key={c.broker.id} className={c.broker.id === broker?.id ? "costs-net" : undefined} title={c.broker.source}>
                    <td>
                      {c.broker.name}
                      {c.broker.verification === "unverified" && <span className="down"> (unverified)</span>}
                    </td>
                    <td>{rs(c.costs)}</td>
                    <td className={c.net >= 0 ? "up" : "down"}>{rs(c.net)}</td>
                    <td>{c.breakeven.toFixed(inst.decimals + 1)} pts</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
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
          <p className="muted costs-note">Upstox MCX schedule, checked against Upstox's own charge calculation on 2026-10-22: brokerage ₹30 per order, futures exchange charge 0.0021%, the rest as listed. Press the button to re-check with your own account.</p>
          <div className="costs-form no-drag">
            {RATE_FIELDS.map(([k, label, step]) => (
              <label key={k}>
                {label}
                <input type="number" step={step} min={0} value={saved.rates[k]} onChange={(ev) => setSaved({ ...saved, rates: { ...saved.rates, [k]: Number(ev.target.value) } })} />
              </label>
            ))}
          </div>
          <div className="no-drag" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "6px 0" }}>
            {(!broker || broker.id === "upstox") && (
              <button className="tf" onClick={() => void checkUpstox()}>
                Check with Upstox
              </button>
            )}
            {upCheck && <span className="muted">{upCheck.text}</span>}
            {upCheck?.differs && (
              <button className="tf" onClick={() => setSaved({ ...saved, rates: { ...saved.rates, brokerageFlat: upCheck.brokerage! } })}>
                Use ₹{upCheck.brokerage} brokerage
              </button>
            )}
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
