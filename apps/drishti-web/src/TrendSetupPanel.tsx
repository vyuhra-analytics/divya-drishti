import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { completedBars, computeDrivers, DRIVER_PAIRS, evaluateSetup, FX_SYMBOL, instrument, premiumSeries, premiumStats, SETUP_RULES, tradingExpiry, type Bar, type CalEvent, type Quote, type StepStatus } from "@drishti/shared";
import { useChain } from "./chainClient";
import { useNow, useSessions } from "./market";
import { apiUrl } from "./settings";
import { useStore } from "./store";
import { useWidgetSymbol, type Widget } from "./workspace";

const MARK: Record<StepStatus, string> = { pass: "✓", fail: "✗", wait: "…", na: "–" };
const WORD: Record<StepStatus, string> = { pass: "passes", fail: "fails", wait: "waiting", na: "not yet" };
const TF = { "1d": 86_400, "1h": 3_600, "15m": 900, "5m": 300 } as const;
type Tf = keyof typeof TF;

async function fetchBars(symbol: string, tf: Tf, signal: AbortSignal): Promise<Bar[]> {
  const res = await fetch(`${apiUrl()}/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Bar[];
}

/** Bars of one symbol and timeframe, re-read every `everyMs`. */
function useBars(symbol: string | undefined, tf: Tf, everyMs: number) {
  const [bars, setBars] = useState<Bar[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBars([]);
    if (!symbol) return;
    const ctrl = new AbortController();
    const load = () =>
      fetchBars(symbol, tf, ctrl.signal)
        .then((b) => {
          setBars(Array.isArray(b) ? b : []);
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(`${tf}: ${e.message}`));
    void load();
    const id = setInterval(load, everyMs);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [symbol, tf, everyMs]);
  return { bars, error };
}

const todayKey = (symbol: string) => `drishti-setup-traded:${symbol}:${new Date(Date.now() + 19_800_000).toISOString().slice(0, 10)}`;
const readTraded = (symbol: string) => {
  try {
    return localStorage.getItem(todayKey(symbol)) === "1";
  } catch {
    return false;
  }
};

/**
 * The trend setup checklist for the linked MCX future: daily bias, 60-minute levels, NYMEX and USD/INR confirmation, the event filter, the 15-minute
 * trigger and the strike, in that order, each with its reason. No order button: the trade is placed by hand. A checklist, not a forecast.
 */
export function TrendSetupWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const inst = instrument(symbol);
  const mcx = inst?.exchange === "MCX";
  const global = DRIVER_PAIRS[symbol];
  const now = useNow(5000);
  const sessions = useSessions();
  const quotes: Record<string, Quote | undefined> = useStore(useShallow((s) => ({ [symbol]: s.quotes[symbol], ...(global ? { [global]: s.quotes[global] } : {}), [FX_SYMBOL]: s.quotes[FX_SYMBOL] })));

  const daily = useBars(mcx ? symbol : undefined, "1d", 15 * 60_000);
  const hourly = useBars(mcx ? symbol : undefined, "1h", 60_000);
  const m15 = useBars(mcx ? symbol : undefined, "15m", 20_000);
  const m5 = useBars(mcx ? symbol : undefined, "5m", 60_000);
  const g5 = useBars(mcx ? global : undefined, "5m", 60_000);
  const f5 = useBars(mcx ? FX_SYMBOL : undefined, "5m", 60_000);

  const [events, setEvents] = useState<CalEvent[]>([]);
  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetch(`${apiUrl()}/calendar?days=3`, { signal: ctrl.signal })
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

  const underlying = inst?.upstox === "CRUDEOILM" ? "CRUDEOIL" : inst?.upstox; // crude mini has no options of its own: the crude chain
  const [expiry, setExpiry] = useState("");
  const { chain } = useChain(underlying ?? "CRUDEOIL", expiry, "auto", 12, mcx && !!underlying);
  useEffect(() => setExpiry(""), [underlying]);
  useEffect(() => {
    const want = chain && expiry === "" ? tradingExpiry(chain.expiries, Date.now()) : undefined;
    if (want && want !== chain!.expiry) setExpiry(want);
  }, [underlying, expiry, chain?.expiry, chain?.expiries.length]);

  const [traded, setTraded] = useState(() => readTraded(symbol));
  useEffect(() => setTraded(readTraded(symbol)), [symbol]);
  const markTraded = (v: boolean) => {
    setTraded(v);
    try {
      if (v) localStorage.setItem(todayKey(symbol), "1");
      else localStorage.removeItem(todayKey(symbol));
    } catch {
      /* the mark lives for this screen only */
    }
  };

  const nowSec = Math.floor(now / 1000);
  const tick = Math.floor(now / 15_000);
  const result = useMemo(() => {
    if (!mcx) return undefined;
    const d = computeDrivers(quotes[symbol], global ? quotes[global] : undefined, quotes[FX_SYMBOL]);
    const stats = d.premiumPct === undefined ? undefined : premiumStats(premiumSeries(m5.bars, g5.bars, f5.bars), d.premiumPct);
    const topic = inst?.topic === "natgas" ? "gas" : "crude";
    const evs = events.filter((e) => e.kind !== "holiday" && e.impact === "high" && (e.relevance ?? []).includes(topic)).map((e) => ({ title: e.title, at: e.at }));
    const mcxS = sessions.MCX;
    return evaluateSetup({
      daily: completedBars(daily.bars, TF["1d"], nowSec),
      hourly: completedBars(hourly.bars, TF["1h"], nowSec),
      m15: completedBars(m15.bars, TF["15m"], nowSec),
      price: quotes[symbol]?.price,
      confirm: { nymexPct: d.split?.global, fxPct: d.split?.fx, premiumRank: stats?.rank },
      events: evs,
      chain: underlying ? chain : undefined,
      now,
      tradedToday: traded,
      minutesToClose: mcxS.open && mcxS.next ? (mcxS.next - now) / 60_000 : undefined,
    });
  }, [mcx, daily.bars, hourly.bars, m15.bars, m5.bars, g5.bars, f5.bars, events, chain, traded, tick, quotes[symbol]?.price, global && quotes[global]?.price, quotes[FX_SYMBOL]?.price]);

  if (!mcx) return <p className="empty muted">The trend setup reads an MCX energy future (crude, crude mini, natural gas, gas mini). Link this panel to one.</p>;
  if (!result) return null;
  const errors = [daily.error, hourly.error, m15.error].filter(Boolean);
  const dp = inst?.decimals ?? 0;
  const f = (n?: number, d = dp) => (n === undefined ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const s = result.strike;

  return (
    <div className="tsetup" tabIndex={0} role="region" aria-label="Trend setup">
      <p className={`tsetup-verdict tsetup-${result.verdict}`}>{result.summary}</p>
      {!sessions.MCX.open && <p className="tsetup-note">MCX is closed: the checklist reads the last bars, not a live market.</p>}
      {errors.length > 0 && <p className="tsetup-note">Bars unavailable ({errors.join("; ")}).</p>}
      <ol className="tsetup-steps">
        {result.steps.map((st) => (
          <li key={st.id} className={`tsetup-${st.status}`}>
            <span className="tsetup-mark" aria-label={WORD[st.status]}>
              {MARK[st.status]}
            </span>
            <div>
              <b>{st.label}</b>
              <span className="tsetup-detail">{st.detail}</span>
            </div>
          </li>
        ))}
      </ol>

      {result.trigger.status === "pass" && (
        <section className="tsetup-plan" aria-label="Trade plan">
          <h2>Plan on the future</h2>
          <p>
            Entry {f(result.trigger.entry)} · stop {f(result.trigger.stop)} · TP1 {f(result.trigger.tp1)} (then stop to entry) · TP2 {f(result.trigger.tp2)} · R {f(result.trigger.rPoints, 1)}
          </p>
          {s && (
            <p>
              Buy {underlying} {s.strike} {s.type} at {f(s.premium, 1)} (|delta| {s.delta.toFixed(2)}, IV {s.iv?.toFixed(1) ?? "—"}%, spread {s.spreadPct?.toFixed(1) ?? "—"}%) · premium stop {f(s.stop, 1)} · TP1 {f(s.tp1, 1)} · TP2 {f(s.tp2, 1)} · 1R ₹{f(s.rupeeR, 0)} for one lot (₹{f(s.cost, 0)})
            </p>
          )}
          {result.invalidation && <p className="muted">{result.invalidation}</p>}
        </section>
      )}
      {!s && result.verdict !== "no-trade" && result.bias !== "none" && <p className="muted">Strike is chosen once the trigger fires.</p>}

      <label className="tsetup-traded">
        <input type="checkbox" checked={traded} onChange={(e) => markTraded(e.target.checked)} /> I took today's trade (one a day, no adding, no averaging down)
      </label>
      <p className="muted tsetup-foot">
        Rules: daily {SETUP_RULES.emaFast}/{SETUP_RULES.emaSlow} EMA and swing structure, 60-minute levels, NYMEX × USD/INR must not contradict, no entry {SETUP_RULES.eventBeforeMin / 60} h before to {SETUP_RULES.eventAfterMin} min after a high-impact release, 15-minute pullback and resume, |delta| {SETUP_RULES.deltaMin}-{SETUP_RULES.deltaMax}, 1R within ₹{SETUP_RULES.lossCap.toLocaleString("en-IN")}. A checklist, not a forecast: not yet tested on history. NYMEX data is 10 minutes late. The {SETUP_RULES.emaLong} EMA needs more daily MCX history than Upstox gives.
      </p>
    </div>
  );
}
