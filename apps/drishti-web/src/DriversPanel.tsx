import { useEffect, useState } from "react";
import { computeDrivers, DRIVER_PAIRS, FX_SYMBOL, premiumSeries, premiumStats, type Bar, type DriverLeg } from "@drishti/shared";
import { apiUrl } from "./settings";
import { useStore } from "./store";
import { useWidgetSymbol, type Widget } from "./workspace";

const REFRESH_MS = 60_000;
const HISTORY_BARS = 600; // about three MCX sessions of 5-minute bars

const num = (n: number | undefined, dp = 2) => (n === undefined ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const signed = (n: number | undefined, dp = 2) => (n === undefined ? "—" : `${n > 0 ? "+" : n < 0 ? "-" : ""}${num(Math.abs(n), dp)}`);
const cls = (n: number | undefined) => (n === undefined || Math.abs(n) < 0.0005 ? "" : n > 0 ? "up" : "down");

async function bars(symbol: string, signal: AbortSignal): Promise<Bar[]> {
  const res = await fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(symbol)}&tf=5m`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as Bar[]).slice(-HISTORY_BARS);
}

function Leg({ name, l, dp, unit }: { name: string; l?: DriverLeg; dp: number; unit: string }) {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td className="drv-price">{l ? num(l.price, dp) : "—"}</td>
      <td className={cls(l?.changePct)}>{signed(l?.changePct)}%</td>
      <td className="muted">
        {unit}
        {l && l.delayMin > 0 && (
          <span className="drv-delay" title={`This feed runs ${l.delayMin} minutes behind (free NYMEX data). Treat it as context: the MCX price is the live one.`}>
            {l.delayMin} min late
          </span>
        )}
      </td>
    </tr>
  );
}

/** What drives the MCX future you trade: the NYMEX contract it follows and USD/INR, the fair value they imply, the premium against its own range, and the day's move split into its parts. */
export function DriversWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const globalSymbol = DRIVER_PAIRS[symbol];
  const quotes = useStore((s) => s.quotes);
  const [history, setHistory] = useState<ReturnType<typeof premiumSeries>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!globalSymbol) return;
    const ctrl = new AbortController();
    const load = () =>
      Promise.all([bars(symbol, ctrl.signal), bars(globalSymbol, ctrl.signal), bars(FX_SYMBOL, ctrl.signal)])
        .then(([m, g, f]) => {
          setHistory(premiumSeries(m, g, f));
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [symbol, globalSymbol]);

  if (!globalSymbol) return <p className="empty muted">Drivers are shown for the four MCX energy futures (crude, crude mini, natural gas, gas mini). Link this panel to one.</p>;

  const d = computeDrivers(quotes[symbol], quotes[globalSymbol], quotes[FX_SYMBOL]);
  const stats = d.premiumPct === undefined ? undefined : premiumStats(history, d.premiumPct);
  const gas = symbol.includes("GAS");
  const parts = d.split && [
    ["NYMEX", d.split.global],
    ["Rupee", d.split.fx],
    ["Premium", d.split.premium],
  ] as const;
  const scale = parts ? Math.max(0.05, ...parts.map(([, v]) => Math.abs(v))) : 1;

  return (
    <div className="drivers" tabIndex={0} role="region" aria-label="What drives the MCX price">
      <table className="drv-legs">
        <thead>
          <tr>
            <th />
            <th>Price</th>
            <th>Day</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <Leg name={symbol.replace("MCX:", "MCX ")} l={d.mcx} dp={gas ? 1 : 0} unit={gas ? "₹/mmBtu" : "₹/bbl"} />
          <Leg name={globalSymbol.replace("NYMEX:", "NYMEX ")} l={d.global} dp={gas ? 3 : 2} unit={gas ? "$/mmBtu" : "$/bbl"} />
          <Leg name="USD/INR" l={d.fx} dp={4} unit="₹" />
        </tbody>
      </table>

      <div className="drv-fair">
        <div>
          <span className="muted">Fair value ({globalSymbol.replace("NYMEX:", "")} × USD/INR)</span>
          <b>{d.fair === undefined ? "—" : num(d.fair, gas ? 1 : 0)}</b>
        </div>
        <div>
          <span className="muted">MCX premium</span>
          <b className={cls(d.premium)}>
            {d.premium === undefined ? "—" : `${signed(d.premium, gas ? 1 : 0)} (${signed(d.premiumPct)}%)`}
          </b>
        </div>
      </div>
      {stats ? (
        <p className="muted drv-note" title={`Premium of the last ${stats.n} five-minute bars: from ${signed(stats.min)}% to ${signed(stats.max)}%, median ${signed(stats.median)}%`}>
          Usual range {signed(stats.min)}% to {signed(stats.max)}%, median {signed(stats.median)}%: now higher than {stats.rank}% of the last {stats.n} bars.
        </p>
      ) : (
        <p className="muted drv-note">{error ? `History unavailable: ${error}` : "Premium history needs the 5-minute bars of all three."}</p>
      )}

      {parts && d.split && (
        <div className="drv-split">
          <div className="muted">
            Today's MCX move <b className={cls(d.split.total)}>{signed(d.split.total)}%</b> is
          </div>
          {parts.map(([name, v]) => (
            <div key={name} className="drv-row">
              <span>{name}</span>
              <span className="drv-bar" aria-hidden="true">
                <i className={v >= 0 ? "up" : "down"} style={{ width: `${(Math.abs(v) / scale) * 50}%`, [v >= 0 ? "left" : "right"]: "50%" }} />
              </span>
              <b className={cls(v)}>{signed(v)}</b>
            </div>
          ))}
          <p className="muted drv-note" title="Log returns against each previous close. NYMEX and MCX close at different times, so a gap between the two closes shows up as premium.">
            Points of percent, against each previous close. The three add up to the total.
          </p>
        </div>
      )}
      <p className="muted drv-note">
        {d.global && d.global.delayMin > 0 ? `NYMEX is ${d.global.delayMin} minutes late on the free feeds: this explains the MCX price, it does not lead it.` : "All three legs are live."}
      </p>
    </div>
  );
}
