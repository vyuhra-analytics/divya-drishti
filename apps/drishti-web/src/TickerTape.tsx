import { contractExpiry, SYMBOLS } from "@drishti/shared";
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
      <div className="tape-track" style={{ animationDuration: `${SYMBOLS.length * SECONDS_PER_ITEM}s` }}>
        {SYMBOLS.map((s) => (
          <TapeItem key={s} symbol={s} />
        ))}
        <span className="tape-copy" aria-hidden="true">
          {SYMBOLS.map((s) => (
            <TapeItem key={s} symbol={s} hidden />
          ))}
        </span>
      </div>
    </section>
  );
}
