import { useMemo, useState } from "react";
import { instrument, rowPcr, type ChainRow, type OptionLeg } from "@drishti/shared";
import { useChain, type ChainFeed } from "./chainClient";
import { makeFormat, useSettings } from "./settings";
import { useWidgetSymbol, type Widget } from "./workspace";

const COLUMN_KEY = "drishti-ocx-columns";
const STEP = 6; // strikes added per side by "Load more"
const START_STRIKES = 10;
const MAX_STRIKES = 40;

type ColId = "volume" | "iv" | "vega" | "gamma" | "theta" | "delta" | "oiChg" | "oi" | "bid" | "ask" | "ltp";
/** The columns of one side, in the order a call side reads (left to right); the put side mirrors it so LTP sits next to the strike on both. */
const COLUMNS: { id: ColId; label: string; tip: string }[] = [
  { id: "volume", label: "Volume", tip: "Contracts traded today" },
  { id: "iv", label: "IV", tip: "Implied volatility, percent" },
  { id: "vega", label: "Vega", tip: "Change in price for a one point rise in implied volatility" },
  { id: "gamma", label: "Gamma", tip: "Change in delta for a one point move in the future" },
  { id: "theta", label: "Theta", tip: "Price lost per day from time passing" },
  { id: "delta", label: "Delta", tip: "Change in price for a one point move in the future" },
  { id: "oiChg", label: "OI chg", tip: "Change in open interest since the baseline shown in the legend" },
  { id: "oi", label: "OI", tip: "Open interest, contracts, with its percent change under it. The bar compares today's with the baseline." },
  { id: "bid", label: "Bid", tip: "Best bid" },
  { id: "ask", label: "Ask", tip: "Best offer" },
  { id: "ltp", label: "LTP", tip: "Last traded price, with the day's change under it" },
];
const ALL = COLUMNS.map((c) => c.id);

const savedColumns = (): ColId[] => {
  try {
    const s = JSON.parse(localStorage.getItem(COLUMN_KEY) ?? "null");
    return Array.isArray(s) ? ALL.filter((c) => s.includes(c)) : ALL;
  } catch {
    return ALL;
  }
};

const FEED_NOTE: Record<string, string> = {
  combined: "TradingView live bid/ask, IV and greeks (every second) with Upstox last trade, open interest and volume (every 3 s)",
  tradingview: "TradingView: live bid/ask, theoretical price, IV and greeks. No open interest or volume.",
  upstox: "Upstox: quotes with open interest and volume",
};

/**
 * Detailed option chain (layout after Upstox's chain widget): calls on the left, puts on the right mirrored so LTP sits beside the strike,
 * bid/ask and every greek, OI with its change and a bar against the baseline, PCR per strike, a spot marker, in-the-money shading and
 * "Load more" strikes. The compact chain (`OC`) stays for small panels. Research only: nothing here places an order.
 */
export function OptionChainWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const inst = instrument(symbol);
  const underlying = inst?.upstox ?? "CRUDEOIL";
  const locale = useSettings((s) => s.locale);
  const [expiry, setExpiry] = useState("");
  const [feed, setFeed] = useState<ChainFeed>("auto");
  const [strikes, setStrikes] = useState(START_STRIKES);
  const [metric, setMetric] = useState<"oi" | "volume">("oi");
  const [cols, setCols] = useState<ColId[]>(savedColumns);
  const { chain, error, reload } = useChain(underlying, expiry, feed, strikes);

  const nf = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
  const price = makeFormat(locale, 2).price;
  const num = (v: number | undefined, d: number) => (v === undefined ? "—" : v.toFixed(d));
  const int = (v: number | undefined) => (v === undefined ? "—" : nf.format(v));
  const signed = (v: number | undefined) => (v === undefined ? "—" : `${v > 0 ? "+" : ""}${nf.format(v)}`);

  const toggleCol = (id: ColId) => {
    const next = cols.includes(id) ? cols.filter((c) => c !== id) : ALL.filter((c) => c === id || cols.includes(c));
    setCols(next);
    try {
      localStorage.setItem(COLUMN_KEY, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };

  const rows = chain?.rows ?? [];
  const spot = chain?.spot;
  const barOf = (l: OptionLeg | undefined) => (metric === "oi" ? l?.oi : l?.volume);
  const maxBar = Math.max(1, ...rows.flatMap((r) => [barOf(r.ce) ?? 0, barOf(r.pe) ?? 0, metric === "oi" ? (r.ce?.prevOi ?? 0) : 0, metric === "oi" ? (r.pe?.prevOi ?? 0) : 0]));
  const shown = COLUMNS.filter((c) => cols.includes(c.id));
  const baselineLabel = chain?.oiBasis === "previous-close" ? "Yesterday's OI" : chain?.oiBasis === "session-open" ? "OI at this session's first reading" : "Baseline OI (none recorded yet)";

  /** One column's cell for one leg. */
  const cell = (id: ColId, l: OptionLeg | undefined, side: "ce" | "pe", itm: boolean) => {
    const cls = `${itm ? "itm " : ""}`;
    switch (id) {
      case "volume":
        return <td key={id} className={cls}>{int(l?.volume)}</td>;
      case "iv":
        return <td key={id} className={cls}>{num(l?.iv, 2)}</td>;
      case "vega":
        return <td key={id} className={cls}>{num(l?.vega, 4)}</td>;
      case "gamma":
        return <td key={id} className={cls}>{num(l?.gamma, 4)}</td>;
      case "theta":
        return <td key={id} className={cls}>{num(l?.theta, 4)}</td>;
      case "delta":
        return <td key={id} className={cls}>{num(l?.delta, 4)}</td>;
      case "oiChg":
        return (
          <td key={id} className={`${cls}${l?.oiChange === undefined ? "" : l.oiChange >= 0 ? "up" : "down"}`}>
            {signed(l?.oiChange)}
          </td>
        );
      case "oi": {
        const v = barOf(l);
        const prev = metric === "oi" ? l?.prevOi : undefined;
        const pct = l?.oiChange !== undefined && l.prevOi ? (l.oiChange / l.prevOi) * 100 : undefined;
        return (
          <td key={id} className={`${cls}ocx-bar ocx-${side}`} style={{ ["--now" as string]: `${Math.round(((v ?? 0) / maxBar) * 100)}%`, ["--prev" as string]: `${Math.round(((prev ?? 0) / maxBar) * 100)}%` }}>
            <span className="ocx-v">{int(v)}</span>
            {metric === "oi" && pct !== undefined && <small className={pct >= 0 ? "up" : "down"}>{`${pct >= 0 ? "+" : ""}${pct.toFixed(2)} %`}</small>}
          </td>
        );
      }
      case "bid":
        return <td key={id} className={cls}>{l?.bid === undefined ? "—" : price(l.bid)}</td>;
      case "ask":
        return <td key={id} className={cls}>{l?.ask === undefined ? "—" : price(l.ask)}</td>;
      case "ltp": {
        const base = l?.ltp !== undefined && l.change !== undefined ? l.ltp - l.change : undefined;
        const pct = base ? ((l!.change ?? 0) / base) * 100 : undefined;
        return (
          <td key={id} className={`${cls}ltp ${l?.change === undefined ? "" : l.change >= 0 ? "up" : "down"}`} title={l?.theo !== undefined ? `Theoretical ${price(l.theo)}` : undefined}>
            {l?.ltp === undefined ? "—" : price(l.ltp)}
            {pct !== undefined && <small>{`${pct >= 0 ? "+" : ""}${pct.toFixed(2)} %`}</small>}
          </td>
        );
      }
    }
  };

  const body: React.ReactNode[] = [];
  let spotDrawn = false;
  const spotRow = (
    <tr key="spot" className="ocx-spot" aria-label="Spot price">
      <td colSpan={shown.length * 2 + 1}>
        <span>
          Spot <b>{spot === undefined ? "—" : price(spot)}</b>
        </span>
      </td>
    </tr>
  );
  for (const r of rows as ChainRow[]) {
    if (!spotDrawn && spot !== undefined && r.strike > spot) {
      body.push(spotRow);
      spotDrawn = true;
    }
    const callItm = spot !== undefined && r.strike < spot;
    const putItm = spot !== undefined && r.strike > spot;
    const p = rowPcr(r);
    body.push(
      <tr key={r.strike} className={r.strike === chain?.atm ? "atm" : ""}>
        {shown.map((c) => cell(c.id, r.ce, "ce", callItm))}
        <td className="ocx-strike">
          <b>{nf.format(r.strike)}</b>
          <small>PCR: {p === undefined ? "—" : p.toFixed(2)}</small>
        </td>
        {[...shown].reverse().map((c) => cell(c.id, r.pe, "pe", putItm))}
      </tr>,
    );
  }
  if (!spotDrawn && rows.length) body.push(spotRow);

  if (!chain) return <p className="empty muted">{error ?? "Loading option chain…"}</p>;
  const span = shown.length * 2 + 1;
  return (
    <div className="ocx">
      <div className="ocx-bar-top no-drag">
        <span className="ocx-title">
          <small className="muted">Option chain for</small>
          <b>{underlying}</b>
        </span>
        <div className="ocx-expiries" role="tablist" aria-label="Expiry">
          {chain.expiries.slice(0, 6).map((x) => (
            <button key={x} role="tab" aria-selected={x === chain.expiry} className={x === chain.expiry ? "tf active" : "tf"} onClick={() => setExpiry(x)}>
              {new Date(`${x}T00:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}
            </button>
          ))}
        </div>
        <span className="ocx-stats">
          <span title="Put/call ratio by open interest over the strikes shown">
            PCR <b>{chain.pcr === undefined ? "—" : chain.pcr.toFixed(2)}</b>
          </span>
          <span title="Strike where option writers pay out least, over the strikes shown">
            Max pain <b>{chain.maxPain === undefined ? "—" : nf.format(chain.maxPain)}</b>
          </span>
          <span title="The future this expiry settles against">
            Spot <b>{spot === undefined ? "—" : price(spot)}</b>
          </span>
        </span>
        <select aria-label="Options feed" value={feed} onChange={(e) => setFeed(e.target.value as ChainFeed)} title="Where the chain comes from">
          <option value="auto">Feed: TradingView + Upstox</option>
          <option value="upstox">Upstox</option>
          <option value="tradingview">TradingView</option>
        </select>
        {chain.source && (
          <span className={`badge src-${chain.source}`} title={FEED_NOTE[chain.source]}>
            {chain.source === "combined" ? "TV + UPSTOX" : chain.source === "tradingview" ? "TV" : "UPSTOX"}
            {chain.delayedBy ? ` ${Math.round(chain.delayedBy / 60)}m delay` : ""}
          </span>
        )}
        <span className="ocx-tools">
          <button className="tf" aria-label="Show open interest bars" aria-pressed={metric === "oi"} onClick={() => setMetric("oi")}>
            OI
          </button>
          <button className="tf" aria-label="Show volume bars" aria-pressed={metric === "volume"} onClick={() => setMetric("volume")}>
            Volume
          </button>
          <button className="tf" aria-label="Refresh" onClick={reload}>
            ↻
          </button>
          <details className="ocx-cols">
            <summary aria-label="Columns">⚙ Columns</summary>
            <div>
              {COLUMNS.map((c) => (
                <label key={c.id}>
                  <input type="checkbox" checked={cols.includes(c.id)} disabled={cols.length === 1 && cols.includes(c.id)} onChange={() => toggleCol(c.id)} /> {c.label}
                </label>
              ))}
              <button className="tf" onClick={() => (setCols(ALL), localStorage.removeItem(COLUMN_KEY))}>
                Show all
              </button>
            </div>
          </details>
        </span>
      </div>
      {error && <p className="down ocx-err">{error}</p>}
      <div className="ocx-scroll" tabIndex={0} role="region" aria-label="Option chain">
        <table>
          <thead>
            <tr className="ocx-side">
              <th colSpan={shown.length}>Calls</th>
              <th />
              <th colSpan={shown.length}>Puts</th>
            </tr>
            <tr>
              {shown.map((c) => (
                <th key={`c-${c.id}`} title={c.tip}>
                  {c.label}
                </th>
              ))}
              <th>Strike</th>
              {[...shown].reverse().map((c) => (
                <th key={`p-${c.id}`} title={c.tip}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="ocx-more">
              <td colSpan={span}>
                <button className="tf" disabled={strikes >= MAX_STRIKES} onClick={() => setStrikes((n) => Math.min(MAX_STRIKES, n + STEP))}>
                  ⌃ Load more strikes
                </button>
                <span className="muted"> {rows.length} strikes shown</span>
              </td>
            </tr>
            {body}
          </tbody>
        </table>
      </div>
      <div className="ocx-legend muted">
        <span>
          <i className="ocx-key now" /> {metric === "oi" ? "Today's OI" : "Today's volume"}
        </span>
        {metric === "oi" && (
          <span>
            <i className="ocx-key prev" /> {baselineLabel}
          </span>
        )}
        <span>OI change is measured against our own stored snapshots: MCX options have no previous-day OI from the exchange feed.</span>
      </div>
    </div>
  );
}
