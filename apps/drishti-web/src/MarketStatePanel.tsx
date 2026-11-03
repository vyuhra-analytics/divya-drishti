import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { completedBars, computeDrivers, DRIVER_PAIRS, FX_SYMBOL, instrument, marketState, nextRelevant, premiumSeries, premiumStats, tradingExpiry, type Bar, type CalEvent, type Group, type Quote, type TodayFocus } from "@drishti/shared";
import { useChain } from "./chainClient";
import { useNow } from "./market";
import { apiUrl } from "./settings";
import { useStore } from "./store";
import { useWidgetSymbol, type Widget } from "./workspace";

const BARS_MS = 30_000;
const GROUPS: Group[] = ["Location", "Pressure", "Options", "Cross-market", "Calendar", "Regime"];
const MARK = { up: "▲", down: "▼", neutral: "●", na: "–" } as const;
const WORD = { up: "leans up", down: "leans down", neutral: "context", na: "cannot be read" } as const;

async function fetchBars(symbol: string, signal: AbortSignal): Promise<Bar[]> {
  const res = await fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(symbol)}&tf=5m`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Bar[];
}

/** The option underlying a linked instrument has a chain for, if any. */
const chainUnderlying = (symbol: string) => (symbol === "NSE:NIFTY" ? "NIFTY" : symbol.startsWith("MCX:") ? instrument(symbol)?.upstox : undefined);

/**
 * The market state right now for the linked instrument: where price sits against the levels, what the book and recent bars lean toward, the option
 * walls, the premium over NYMEX x USD/INR and the next release. Every reading is one stated rule; disagreement is shown, not averaged. It is a read of
 * the present, not a forecast: whether any lean has ever paid is measured separately (scripts/state-forward.ts).
 */
export function MarketStateWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const inst = instrument(symbol);
  const globalSymbol = DRIVER_PAIRS[symbol];
  const quotes: Record<string, Quote | undefined> = useStore(useShallow((s) => ({ [symbol]: s.quotes[symbol], ...(globalSymbol ? { [globalSymbol]: s.quotes[globalSymbol] } : {}), [FX_SYMBOL]: s.quotes[FX_SYMBOL] })));
  const now = useNow(5000);
  const [bars, setBars] = useState<Bar[]>([]);
  const [premiumBars, setPremiumBars] = useState<{ g: Bar[]; f: Bar[] } | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBars([]);
    const ctrl = new AbortController();
    const load = () =>
      fetchBars(symbol, ctrl.signal)
        .then((b) => {
          setBars(b);
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    void load();
    const id = setInterval(load, BARS_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [symbol]);

  useEffect(() => {
    setPremiumBars(null);
    if (!globalSymbol) return;
    const ctrl = new AbortController();
    const load = () =>
      Promise.all([fetchBars(globalSymbol, ctrl.signal), fetchBars(FX_SYMBOL, ctrl.signal)])
        .then(([g, f]) => setPremiumBars({ g, f }))
        .catch(() => undefined); // the premium reading is simply left out
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [globalSymbol]);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetch(`${apiUrl()}/calendar?days=2`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then((e) => setEvents(Array.isArray(e) ? e : []))
        .catch(() => undefined);
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, []);

  const underlying = chainUnderlying(symbol);
  const [expiry, setExpiry] = useState("");
  const { chain } = useChain(underlying ?? "CRUDEOIL", expiry, underlying === "NIFTY" ? "upstox" : "auto", 12, !!underlying);
  useEffect(() => setExpiry(""), [underlying]);
  useEffect(() => {
    const want = underlying && chain && expiry === "" ? tradingExpiry(chain.expiries, Date.now()) : undefined;
    if (want && want !== chain!.expiry) setExpiry(want);
  }, [underlying, expiry, chain?.expiry, chain?.expiries.length]);

  const quote = quotes[symbol];
  const done = useMemo(() => completedBars(bars, 300, Math.floor(now / 1000)), [bars, Math.floor(now / 30_000)]);
  const premium = useMemo(() => {
    if (!premiumBars || !globalSymbol) return undefined;
    const d = computeDrivers(quote, quotes[globalSymbol], quotes[FX_SYMBOL]);
    if (d.premiumPct === undefined) return undefined;
    const st = premiumStats(premiumSeries(bars, premiumBars.g, premiumBars.f), d.premiumPct);
    return { pct: d.premiumPct, rank: st?.rank, median: st?.median };
  }, [premiumBars, bars, quote?.price, globalSymbol && quotes[globalSymbol]?.price, quotes[FX_SYMBOL]?.price]);
  const focus: TodayFocus = inst?.topic === "natgas" ? "gas" : inst?.topic === "crude" ? "crude" : "all";
  const next = useMemo(() => nextRelevant(events, now - 5 * 60_000, focus, true), [events, focus, Math.floor(now / 30_000)]);
  const event = next ? { title: next.title, at: next.at } : undefined;

  const state = useMemo(() => marketState({ quote, bars: done, chain: underlying ? chain : undefined, premium, event, now, decimals: inst?.decimals }), [quote, done, chain, premium, event?.at, Math.floor(now / 5000), inst?.decimals, underlying]);

  return (
    <div className={`mstate${state.stale ? " mstate-stale" : ""}`} tabIndex={0} role="region" aria-label="Market state">
      <p className={`mstate-sum ${state.agreement}`}>{state.summary}</p>
      {state.caveats.map((c) => (
        <p key={c} className="mstate-caveat">
          {c}
        </p>
      ))}
      {error && <p className="mstate-caveat">Bars unavailable: {error}</p>}
      {GROUPS.map((g) => {
        const rs = state.readings.filter((r) => r.group === g);
        if (!rs.length) return null;
        return (
          <section key={g} className="mstate-group">
            <h2>{g}</h2>
            <table>
              <tbody>
                {rs.map((r) => (
                  <tr key={r.id} className={`mstate-${r.lean}${r.warn ? " mstate-warn" : ""}`} title={`${r.label}: ${WORD[r.lean]}. ${r.note}`}>
                    <td className="mstate-mark" aria-label={WORD[r.lean]}>
                      {MARK[r.lean]}
                    </td>
                    <th scope="row">{r.label}</th>
                    <td className="mstate-val">{r.value || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      <p className="muted mstate-foot">
        ▲ ▼ = a stated rule leans that way (hover for the rule), ● = context only. A read of now, not a forecast: no lean has been shown to pay yet. Book figures are inferred from the quoted depth.
      </p>
    </div>
  );
}
