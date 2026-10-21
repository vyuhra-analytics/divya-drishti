import { contractExpiry, FX_PAIRS, SYMBOLS, type FxPair } from "@drishti/shared";
import { useEffect, useState } from "react";
import { useFormat, useSettings } from "./settings";
import { useStore } from "./store";
import { useWorkspace } from "./workspace";
import { Price } from "./widgets";

const SECONDS_PER_ITEM = 9; // scroll speed: the whole tape takes this long per instrument, so adding one does not make it faster

/** "CRUDEOIL FUT 19 NOV 26" → "Exp. 19 Nov"; undefined for a feed that does not name the contract (NYMEX continuous). */
const expiryLabel = (contract?: string) => {
  const ms = contractExpiry(contract);
  return ms === undefined ? undefined : `Exp. ${new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`;
};

function TapeItem({ symbol, hidden }: { symbol: string; hidden?: boolean }) {
  const q = useStore((s) => s.quotes[symbol]);
  const fmt = useFormat(symbol);
  const change = q?.prevClose ? q.price - q.prevClose : undefined;
  const pct = q?.prevClose && change !== undefined ? (change / q.prevClose) * 100 : undefined;
  const dir = change === undefined ? "" : change >= 0 ? "up" : "down";
  const open = () => {
    const { widgets, focusedId, loadSymbol } = useWorkspace.getState();
    const target = widgets.find((w) => w.id === focusedId) ?? widgets[0];
    if (target) loadSymbol(target.id, symbol);
  };
  const expiry = expiryLabel(q?.contract);
  return (
    <button className="tape-item" onClick={open} tabIndex={hidden ? -1 : 0} title={`Show ${symbol} in the focused panel`}>
      <span className="tape-name">{symbol.split(":")[1]}</span>
      <Price symbol={symbol} />
      {change !== undefined && pct !== undefined && (
        <span className={dir}>
          {change >= 0 ? "+" : "−"}
          {fmt.price(Math.abs(change))} ({change >= 0 ? "+" : "−"}
          {Math.abs(pct).toFixed(2)}%)
        </span>
      )}
      {expiry && <span className="muted tape-exp">{expiry}</span>}
    </button>
  );
}

const FX_STALE_MS = 30_000; // the stream re-sends every row every 5 s while its feed works

/** A currency pair: the same layout as a futures item, with "FX" where the expiry goes and no click action (it is context, not a tradable symbol here). */
function FxItem({ pair, hidden }: { pair: FxPair; hidden?: boolean }) {
  const row = useStore((s) => s.fx[pair.id]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  const stale = row ? now - row.time > FX_STALE_MS : false;
  const dir = row?.change === undefined ? "" : row.change >= 0 ? "up" : "down";
  const f = (n: number, d = pair.decimals) => n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  return (
    <span className={`tape-item tape-fx${stale ? " not-live" : ""}`} aria-hidden={hidden || undefined} title={!row ? undefined : stale ? "No update from the feed for over 30 seconds" : row.delayedBy ? `${Math.round(row.delayedBy / 60)} min delayed` : "Live"}>
      <span className="tape-name">{pair.name}</span>
      {row ? <span className={dir}>{f(row.price)}</span> : <span className="muted">—</span>}
      {row?.change !== undefined && row.changePct !== undefined && (
        <span className={dir}>
          {row.change >= 0 ? "+" : "−"}
          {f(Math.abs(row.change))} ({row.change >= 0 ? "+" : "−"}
          {Math.abs(row.changePct).toFixed(2)}%)
        </span>
      )}
      <span className="muted tape-exp">{row?.delayedBy ? `${Math.round(row.delayedBy / 60)}m delay` : "FX"}</span>
    </span>
  );
}

/**
 * A scrolling strip of every tracked instrument with its live price, change and expiry, like a broker's ticker tape. The list is rendered
 * twice and slid by half its width, so the loop has no jump; hovering or focusing pauses it, and with reduced motion it does not move
 * (it scrolls by hand instead). Clicking an item shows that symbol in the focused panel.
 */
export function TickerTape() {
  const on = useSettings((s) => s.tickerTape);
  if (!on || SYMBOLS.length === 0) return null;
  return (
    <section className="tape" aria-label="Price ticker">
      <div className="tape-track" style={{ animationDuration: `${(SYMBOLS.length + FX_PAIRS.length) * SECONDS_PER_ITEM}s` }}>
        {SYMBOLS.map((s) => (
          <TapeItem key={s} symbol={s} />
        ))}
        {FX_PAIRS.map((p) => (
          <FxItem key={p.id} pair={p} />
        ))}
        <span className="tape-copy" aria-hidden="true">
          {SYMBOLS.map((s) => (
            <TapeItem key={s} symbol={s} hidden />
          ))}
          {FX_PAIRS.map((p) => (
            <FxItem key={p.id} pair={p} hidden />
          ))}
        </span>
      </div>
    </section>
  );
}
