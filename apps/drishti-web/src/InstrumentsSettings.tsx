import { useState } from "react";
import { INSTRUMENTS, parseCustomInstrument } from "@drishti/shared";
import { instrumentsCall, syncInstruments } from "./instrumentsClient";

const EMPTY = { exchange: "MCX", root: "", name: "", decimals: "2", lot: "", topic: "crude", upstox: "", tv: "", yahoo: "" };

/** Settings → Instruments: the built-in futures (fixed) and the ones you added, with a form to track another MCX or NYMEX energy future. */
export function InstrumentsSettings() {
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setError(null);
  };
  const mcx = f.exchange === "MCX";
  const check = f.root || f.name || f.lot ? parseCustomInstrument(f) : null; // shown as you type, so most mistakes never reach the server
  const problem = check && "error" in check ? check.error : null;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!check || "error" in check || busy) return;
    setBusy(true);
    const r = await instrumentsCall("", "POST", f);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setF(EMPTY);
    await syncInstruments();
  }

  async function remove(symbol: string) {
    if (!confirm(`Stop tracking ${symbol}? Panels set to it will need another symbol.`)) return;
    const r = await instrumentsCall(`/${encodeURIComponent(symbol)}`, "DELETE");
    if (!r.ok) return setError(r.error);
    await syncInstruments();
  }

  return (
    <>
      <div className="set-cards">
      {INSTRUMENTS.map((i) => (
        <div className="field" key={i.symbol}>
          <span>
            {i.name}
            <small className="muted">
              {i.symbol} · {i.lot}
              {i.custom ? " · added by you" : " · built in"}
            </small>
          </span>
          {i.custom && (
            <button className="btn" onClick={() => remove(i.symbol)}>
              Remove
            </button>
          )}
        </div>
      ))}
      </div>
      <form className="set-grid" onSubmit={add} aria-label="Add instrument">
        <div className="field">
          <span>Exchange</span>
          <select value={f.exchange} onChange={(e) => set("exchange", e.target.value)} aria-label="Exchange">
            <option value="MCX">MCX (₹)</option>
            <option value="NYMEX">NYMEX (US$, 10 min delay)</option>
          </select>
        </div>
        <div className="field">
          <span>
            Symbol<small className="muted">{mcx ? "as Upstox names it, e.g. ZINC" : "TradingView root, e.g. RB"}</small>
          </span>
          <input value={f.root} onChange={(e) => set("root", e.target.value.toUpperCase())} aria-label="Symbol" />
        </div>
        <div className="field">
          <span>Name</span>
          <input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Zinc" aria-label="Name" />
        </div>
        <div className="field">
          <span>
            Lot<small className="muted">units then unit</small>
          </span>
          <input value={f.lot} onChange={(e) => set("lot", e.target.value)} placeholder="5000 kg" aria-label="Lot" />
        </div>
        <div className="field">
          <span>Price decimals</span>
          <select value={f.decimals} onChange={(e) => set("decimals", e.target.value)} aria-label="Price decimals">
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <span>
            News topic<small className="muted">which headlines show beside it</small>
          </span>
          <select value={f.topic} onChange={(e) => set("topic", e.target.value)} aria-label="News topic">
            <option value="crude">Crude and oil</option>
            <option value="natgas">Natural gas</option>
          </select>
        </div>
        {mcx ? (
          <div className="field">
            <span>
              Upstox underlying<small className="muted">only if it differs from the symbol</small>
            </span>
            <input value={f.upstox} onChange={(e) => set("upstox", e.target.value.toUpperCase())} aria-label="Upstox underlying" />
          </div>
        ) : (
          <div className="field">
            <span>
              Yahoo symbol<small className="muted">default {f.root || "RB"}=F</small>
            </span>
            <input value={f.yahoo} onChange={(e) => set("yahoo", e.target.value.toUpperCase())} aria-label="Yahoo symbol" />
          </div>
        )}
        <div className="field">
          <span>
            TradingView root<small className="muted">default {mcx ? `MCX:${f.root || "ZINC"}` : `NYMEX:${f.root || "RB"}1!`}</small>
          </span>
          <input value={f.tv} onChange={(e) => set("tv", e.target.value.toUpperCase())} aria-label="TradingView root" />
        </div>
        {(error || problem) && (
          <p className="field-error wide" role="alert">
            {error ?? problem}
          </p>
        )}
        <div className="field wide">
          <span className="muted">{check && "instrument" in check ? `Will track ${check.instrument.symbol}` : "Fill in the symbol, name and lot"}</span>
          <button className="btn" disabled={!check || "error" in check || busy}>
            {busy ? "Adding…" : "Add instrument"}
          </button>
        </div>
      </form>
      <p className="muted hint">
        Energy futures on MCX and NYMEX only. MCX symbols are checked against Upstox's instrument list. An added instrument gets a live price, chart history, options (MCX), alerts and paper trading; the built-in desks stay as they are.
      </p>
    </>
  );
}
