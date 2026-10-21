import { useMemo, useState } from "react";
import { instrument, lotUnits, summarizeAccount, unrealisedNet, type Side } from "@drishti/shared";
import { useFreshness } from "./market";
import { costRates, usePaper } from "./paperStore";
import { useClock, useSettings } from "./settings";
import { useStore } from "./store";
import { useWidgetSymbol, type Widget } from "./workspace";

const REASON = { manual: "Closed by hand", stop: "Stop hit", target: "Target hit" } as const;

/** Paper trading on live quotes with Upstox costs, stops and targets, and a journal. Simulated only: nothing ever reaches a broker. */
export function PaperWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const inst = instrument(symbol);
  const locale = useSettings((s) => s.locale);
  const clock = useClock();
  const quotes = useStore((s) => s.quotes);
  const fresh = useFreshness(symbol);
  const { capital, slippage, positions, trades, setCapital, setSlippage, place, close, setNote, reset } = usePaper();
  const [side, setSide] = useState<Side>("buy");
  const [lots, setLots] = useState(1);
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const nf = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
  const rs = (v: number) => `${v < 0 ? "−" : ""}₹${nf.format(Math.abs(v))}`;
  const px = (symbol: string, v: number) => v.toFixed(instrument(symbol)?.decimals ?? 2);

  const opens = positions.map((p) => {
    const q = quotes[p.symbol];
    return { p, q, net: q ? unrealisedNet(p, q, slippage, costRates()) : 0 };
  });
  const account = summarizeAccount(capital, [...trades].reverse(), opens.map((o) => o.net));
  const last = quotes[symbol]?.price;
  const mcx = inst?.exchange === "MCX" && lotUnits(symbol) !== undefined;

  const submit = () => {
    const err = place(symbol, side, lots, stop === "" ? undefined : Number(stop), target === "" ? undefined : Number(target));
    setMsg(err ?? null);
    if (!err) {
      setStop("");
      setTarget("");
    }
  };

  return (
    <div className="paper">
      <div className="paper-body" tabIndex={0} role="region" aria-label="Paper trading">
        <div className="paper-acct">
          <div>
            <span className="muted">Equity</span>
            <strong>{rs(account.equity)}</strong>
          </div>
          <div>
            <span className="muted">Realised</span>
            <strong className={account.realised >= 0 ? "up" : "down"}>{rs(account.realised)}</strong>
          </div>
          <div>
            <span className="muted">Open</span>
            <strong className={account.unrealised >= 0 ? "up" : "down"}>{rs(account.unrealised)}</strong>
          </div>
          <div title="Brokerage, CTT, exchange, SEBI, stamp duty and GST on closed trades">
            <span className="muted">Costs paid</span>
            <strong>{rs(account.costsPaid)}</strong>
          </div>
        </div>

        <h2>Order ticket</h2>
        {!mcx ? (
          <p className="muted">Link this panel to an MCX contract to place a paper order (costs follow Upstox's MCX schedule).</p>
        ) : (
          <>
            <div className="costs-form no-drag">
              <label>
                Side
                <select value={side} onChange={(ev) => setSide(ev.target.value as Side)}>
                  <option value="buy">Buy (long)</option>
                  <option value="sell">Sell (short)</option>
                </select>
              </label>
              <label>
                Lots
                <input type="number" min={1} step={1} value={lots} onChange={(ev) => setLots(Math.max(1, Math.floor(Number(ev.target.value) || 1)))} />
              </label>
              <label>
                Stop (optional)
                <input type="number" step="any" value={stop} placeholder={last === undefined ? "" : px(symbol, last * (side === "buy" ? 0.995 : 1.005))} onChange={(ev) => setStop(ev.target.value)} />
              </label>
              <label>
                Target (optional)
                <input type="number" step="any" value={target} placeholder={last === undefined ? "" : px(symbol, last * (side === "buy" ? 1.01 : 0.99))} onChange={(ev) => setTarget(ev.target.value)} />
              </label>
            </div>
            <button className="tf active" onClick={submit}>
              {side === "buy" ? "Buy" : "Sell"} {lots} lot{lots === 1 ? "" : "s"} {inst!.name} at market{last === undefined ? "" : ` (${px(symbol, last)})`}
            </button>
            {fresh !== "live" && <span className="muted paper-state"> · market {fresh}: orders wait for a live price</span>}
            {msg && <p className="down">{msg}</p>}
          </>
        )}

        <h2>Open positions</h2>
        {opens.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Side</th>
                <th>Lots</th>
                <th>Entry</th>
                <th>Now</th>
                <th>Stop / target</th>
                <th title="Net of exit costs">P&amp;L</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {opens.map(({ p, q, net }) => (
                <tr key={p.id}>
                  <td>{p.symbol.split(":")[1]}</td>
                  <td>{p.side === "buy" ? "Long" : "Short"}</td>
                  <td>{p.lots}</td>
                  <td>{px(p.symbol, p.entry)}</td>
                  <td>{q ? px(p.symbol, q.price) : "—"}</td>
                  <td className="muted">
                    {p.stop === undefined ? "—" : px(p.symbol, p.stop)} / {p.target === undefined ? "—" : px(p.symbol, p.target)}
                  </td>
                  <td className={net >= 0 ? "up" : "down"}>{rs(net)}</td>
                  <td>
                    <button className="tf" onClick={() => close(p.id)}>
                      Close
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>
          Journal <small className="muted">· {account.trades} trades, win rate {(account.winRate * 100).toFixed(0)}%, worst drawdown {rs(account.maxDrawdown)}</small>
        </h2>
        {trades.length === 0 ? (
          <p className="muted">Closed trades appear here with their gross-to-net costs.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Closed</th>
                <th>Trade</th>
                <th>Gross</th>
                <th>Costs</th>
                <th>Net</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 30).map((t) => (
                <tr key={t.id}>
                  <td className="muted">{clock.stamp(t.closedAt)}</td>
                  <td title={REASON[t.reason]}>
                    {t.symbol.split(":")[1]} {t.side === "buy" ? "long" : "short"} {t.lots}× {px(t.symbol, t.entry)}→{px(t.symbol, t.exit)} <small className="muted">{REASON[t.reason]}</small>
                  </td>
                  <td>{rs(t.gross)}</td>
                  <td className="muted">{rs(t.costs)}</td>
                  <td className={t.net >= 0 ? "up" : "down"}>{rs(t.net)}</td>
                  <td>
                    <input className="paper-note no-drag" aria-label={`Note for the ${t.symbol} trade`} value={t.note} maxLength={500} placeholder="Why / what I learned" onChange={(ev) => setNote(t.id, ev.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <details>
          <summary>Account settings</summary>
          <div className="costs-form no-drag">
            <label>
              Starting capital (₹)
              <input type="number" min={0} step={10000} value={capital} onChange={(ev) => setCapital(Number(ev.target.value))} />
            </label>
            <label title="Points paid against you on every fill">
              Slippage (points)
              <input type="number" min={0} step="any" value={slippage} onChange={(ev) => setSlippage(Number(ev.target.value))} />
            </label>
          </div>
          <button
            className="tf"
            onClick={() => {
              if (window.confirm("Clear every open position and the whole journal?")) reset();
            }}
          >
            Reset account
          </button>
        </details>
        <p className="muted paper-note-text">Simulated fills on live quotes (buys at the ask, sells at the bid, plus slippage) with the cost rates from the Costs panel. Stops and targets act only while this app is open and the market is live. Nothing is ever sent to a broker.</p>
      </div>
    </div>
  );
}
