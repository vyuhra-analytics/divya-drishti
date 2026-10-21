import { useEffect, useState } from "react";
import { instrument, type Chain, type OptionLeg } from "@drishti/shared";
import { apiUrl, makeFormat, useSettings } from "./settings";
import { useWidgetSymbol, type Widget } from "./workspace";

const POLL_MS = 3000;

/** MCX options chain for the linked contract's underlying (CRUDEOIL when the linked symbol isn't MCX). */
export function OptionsWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const inst = instrument(symbol);
  const underlying = inst?.upstox ?? "CRUDEOIL";
  const locale = useSettings((s) => s.locale);
  const [expiry, setExpiry] = useState<string>("");
  const [feed, setFeed] = useState<"auto" | "upstox" | "tradingview">("auto");
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState<string | null>(null);

  // a different underlying has different expiries: forget the chosen one
  useEffect(() => {
    setExpiry("");
    setChain(null);
  }, [underlying]);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const load = async () => {
      if (document.hidden) return; // don't poll Upstox for a hidden tab
      try {
        const res = await fetch(`${apiUrl()}/options?underlying=${underlying}&source=${feed}${expiry ? `&expiry=${expiry}` : ""}`, { signal: ctrl.signal });
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
        setChain(json);
        setError(null);
      } catch (e) {
        if (alive && (e as Error).name !== "AbortError") setError((e as Error).message);
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(id);
    };
  }, [underlying, expiry, feed]);

  const price = makeFormat(locale, 1).price;
  const compact = makeFormat(locale, 0).volume;
  const maxOi = Math.max(1, ...(chain?.rows ?? []).flatMap((r) => [r.ce?.oi ?? 0, r.pe?.oi ?? 0]));
  const spot = chain?.spot;

  /** One side's four cells; puts mirror calls (LTP next to the strike), and in-the-money cells are tinted. */
  const leg = (l: OptionLeg | undefined, side: "ce" | "pe", itm: boolean) => {
    const tint = itm ? " itm" : "";
    const cells = [
      <td key="oi" className={`oi${tint}`} style={{ ["--oi" as string]: `${Math.round(((l?.oi ?? 0) / maxOi) * 100)}%` }}>
        {l?.oi === undefined ? "—" : compact(l.oi)}
      </td>,
      <td key="iv" className={tint.trim()}>
        {l?.iv === undefined ? "—" : l.iv.toFixed(1)}
      </td>,
      <td key="d" className={tint.trim()}>
        {l?.delta === undefined ? "—" : l.delta.toFixed(2)}
      </td>,
      <td
        key="ltp"
        className={`ltp${tint} ${l?.change === undefined ? "" : l.change >= 0 ? "up" : "down"}`}
        title={l?.bid !== undefined ? `Bid ${price(l.bid)} · Ask ${price(l.ask)}${l.theo !== undefined ? ` · Theo ${price(l.theo)}` : ""}` : undefined}
      >
        {l?.ltp === undefined ? "—" : price(l.ltp)}
      </td>,
    ];
    return side === "ce" ? cells : cells.reverse();
  };

  if (!chain) {
    return <p className="empty muted">{error ?? "Loading options chain…"}</p>;
  }
  return (
    <div className="options">
      <div className="toolbar no-drag">
        <span className="muted">{underlying}</span>
        <select aria-label="Expiry" value={chain.expiry} onChange={(e) => setExpiry(e.target.value)}>
          {chain.expiries.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <select aria-label="Options feed" value={feed} onChange={(e) => setFeed(e.target.value as typeof feed)} title="Where the chain comes from">
          <option value="auto">Feed: auto</option>
          <option value="upstox">Upstox</option>
          <option value="tradingview">TradingView</option>
        </select>
        {chain.source && (
          <span
            className={`badge src-${chain.source}`}
            title={chain.source === "tradingview" ? "TradingView: live bid/ask, theoretical price, IV and greeks. No open interest or volume, so PCR and max pain need Upstox." : "Upstox: quotes with open interest and volume"}
          >
            {chain.source === "tradingview" ? "TV" : "UPSTOX"}
            {chain.delayedBy ? ` ${Math.round(chain.delayedBy / 60)}m delay` : ""}
          </span>
        )}
        <span title="Future this expiry settles against">
          Spot <b>{spot === undefined ? "—" : price(spot)}</b>
        </span>
        <span title="Put/call ratio by open interest, over the strikes shown">
          PCR <b>{chain.pcr === undefined ? "—" : chain.pcr.toFixed(2)}</b>
        </span>
        <span title="Strike where option writers pay out least, over the strikes shown">
          Max pain <b>{chain.maxPain ?? "—"}</b>
        </span>
        {error && <span className="down" title={error}>stale</span>}
      </div>
      <div className="options-scroll" tabIndex={0} role="region" aria-label="Options chain table">
        <table>
          <thead>
            <tr>
              <th colSpan={4}>CALLS</th>
              <th />
              <th colSpan={4}>PUTS</th>
            </tr>
            <tr>
              <th>OI</th>
              <th>IV</th>
              <th>Δ</th>
              <th>LTP</th>
              <th>Strike</th>
              <th>LTP</th>
              <th>Δ</th>
              <th>IV</th>
              <th>OI</th>
            </tr>
          </thead>
          <tbody>
            {chain.rows.map((r) => (
              <tr key={r.strike} className={r.strike === chain.atm ? "atm" : undefined}>
                {leg(r.ce, "ce", spot !== undefined && r.strike < spot)}
                <td className="strike">{r.strike}</td>
                {leg(r.pe, "pe", spot !== undefined && r.strike > spot)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
