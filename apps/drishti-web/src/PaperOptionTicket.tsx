import { useEffect, useMemo, useState } from "react";
import { PROFILE_UNDERLYINGS, type ChainRow, type ProfileUnderlying } from "@drishti/shared";
import { useChain } from "./chainClient";
import { sendWatch, useStore } from "./store";

// The order ticket for paper OPTIONS (buy only, as the strategies buy calls and puts): pick the underlying, expiry, call or put and strike from the live chain,
// see the premium (the live option quote when the stream is watching it), set optional stop and target in PREMIUM, and buy at the ask plus slippage. The server
// fills it and follows its stop and target on the option's own quotes, even with this window closed. Simulated: nothing reaches a broker.

const LIVE_MS = 10_000;
const num = (v: number | undefined, dp = 1) => (v === undefined ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));

export function PaperOptionTicket({ onOrder, busy }: { onOrder: (body: object) => Promise<boolean>; busy?: boolean }) {
  const [underlying, setUnderlying] = useState<ProfileUnderlying>("CRUDEOIL");
  const [expiry, setExpiry] = useState("");
  const [type, setType] = useState<"CE" | "PE">("CE");
  const [strike, setStrike] = useState<number | undefined>(undefined);
  const [lots, setLots] = useState(1);
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const { chain, error } = useChain(underlying, expiry, "auto", 8);
  useEffect(() => {
    setExpiry("");
    setStrike(undefined);
  }, [underlying]);

  // the strikes around the money, and the one chosen (the money strike until the trader picks)
  const rows = useMemo<ChainRow[]>(() => {
    if (!chain) return [];
    const sorted = [...chain.rows].sort((a, b) => a.strike - b.strike);
    const i = Math.max(0, sorted.findIndex((r) => r.strike === chain.atm));
    return sorted.slice(Math.max(0, i - 4), i + 5);
  }, [chain]);
  const row = rows.find((r) => r.strike === strike) ?? rows.find((r) => r.strike === chain?.atm) ?? rows[0];
  const leg = type === "CE" ? row?.ce : row?.pe;
  const key = leg?.ukey;

  // ask the stream to watch the chosen contract so its live premium (and a fill) is there
  useEffect(() => {
    if (!key) return;
    sendWatch([key]);
    const id = setInterval(() => sendWatch([key]), 20_000);
    return () => clearInterval(id);
  }, [key]);
  const live = useStore((s) => (key ? s.options[key] : undefined));
  const fresh = live !== undefined && Date.now() - live.recvAt < LIVE_MS;
  const ask = fresh ? (live.ask && live.ask > 0 ? live.ask : live.price) : leg?.ask && leg.ask > 0 ? leg.ask : leg?.ltp;
  const bid = fresh ? live.bid : leg?.bid;
  const name = chain && row ? `${underlying} ${row.strike} ${type} ${chain.expiry}` : "";

  return (
    <div className="paper-options">
      <div className="costs-form no-drag">
        <label>
          Underlying
          <select value={underlying} onChange={(ev) => setUnderlying(ev.target.value as ProfileUnderlying)}>
            {PROFILE_UNDERLYINGS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
        <label>
          Expiry
          <select value={expiry || chain?.expiry || ""} onChange={(ev) => setExpiry(ev.target.value)}>
            {(chain?.expiries ?? []).map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
        </label>
        <label>
          Call or put
          <select value={type} onChange={(ev) => setType(ev.target.value as "CE" | "PE")}>
            <option value="CE">Call (CE)</option>
            <option value="PE">Put (PE)</option>
          </select>
        </label>
        <label>
          Strike
          <select value={row?.strike ?? ""} onChange={(ev) => setStrike(Number(ev.target.value))}>
            {rows.map((r) => {
              const l = type === "CE" ? r.ce : r.pe;
              return (
                <option key={r.strike} value={r.strike}>
                  {r.strike}
                  {r.strike === chain?.atm ? " ATM" : ""} · {num(l?.ask && l.ask > 0 ? l.ask : l?.ltp)} · δ {num(l?.delta === undefined ? undefined : Math.abs(l.delta), 2)}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          Lots
          <input type="number" min={1} step={1} value={lots} onChange={(ev) => setLots(Math.max(1, Math.floor(Number(ev.target.value) || 1)))} />
        </label>
        <label title="A premium: the position closes when the option's price falls to it">
          Stop (premium, optional)
          <input type="number" step="any" value={stop} placeholder={ask === undefined ? "" : num(ask * 0.7)} onChange={(ev) => setStop(ev.target.value)} />
        </label>
        <label title="A premium: the position closes when the option's price rises to it">
          Target (premium, optional)
          <input type="number" step="any" value={target} placeholder={ask === undefined ? "" : num(ask * 1.5)} onChange={(ev) => setTarget(ev.target.value)} />
        </label>
      </div>
      {error && <p className="down">{error}</p>}
      {!chain && !error && <p className="muted">Loading the option chain…</p>}
      <button
        className="tf active"
        disabled={!key || busy}
        onClick={async () => {
          const ok = await onOrder({ option: { key }, side: "buy", lots, ...(stop !== "" ? { stop: Number(stop) } : {}), ...(target !== "" ? { target: Number(target) } : {}) });
          if (ok) {
            setStop("");
            setTarget("");
          }
        }}
      >
        Buy {lots} lot{lots === 1 ? "" : "s"} {name} at the ask{ask === undefined ? "" : ` (${num(ask)})`}
      </button>
      {ask !== undefined && leg && (
        <span className="muted paper-state">
          {" "}
          · bid {num(bid)} · {fresh ? "live quote" : "polled chain"}
          {chain?.lot ? ` · 1 lot = ${num(ask * chain.lot, 0)} rupees` : ""}
        </span>
      )}
    </div>
  );
}
