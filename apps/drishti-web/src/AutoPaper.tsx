import { useEffect, useMemo, useRef, useState } from "react";
import { AUTO_ACCOUNT, AUTO_CAPITAL, AUTO_EVENT_TEXT, asManualTrade, autoSymbol, DAY_RULES, decideAuto, planAutoOrder, signalFresh, trackTrade, type AutoRecord, type DayBar, type DaySide } from "@drishti/shared";
import { paperCall } from "./paperClient";
import { useClock } from "./settings";
import { useStore } from "./store";
import { usePublishLevels } from "./strategyLevels";
import { Switch } from "./ui";

// The automatic PAPER trade of a signal (report day and USIB): when a signal fires and the switch is on, a futures paper order is placed in the separate "auto"
// account, sized so the loss at the 1R stop stays inside the Rs 2,000 cap. The server holds the stop (and, on the report day, the TP2 target), so they fire even
// with this browser closed; this component moves the stop to the entry at TP1, trails it in USIB, and closes at the time exit. Simulated only: no broker is
// ever reached. A signal armed too late is skipped, never chased. The decisions are in shared autoTrade.ts.

const REC_KEY = "drishti-autopaper";
const ARM_KEY = "drishti-autopaper-armed";
const KEEP = 30;

const loadAll = (): Record<string, AutoRecord> => {
  try {
    return JSON.parse(localStorage.getItem(REC_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
};
const loadRec = (key: string): AutoRecord | undefined => loadAll()[key];
function saveRec(key: string, rec: AutoRecord) {
  try {
    const all = { ...loadAll(), [key]: rec };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete all[k];
    localStorage.setItem(REC_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: the trade carries on for this session */
  }
}
const loadArmed = () => {
  try {
    return localStorage.getItem(ARM_KEY) === "1";
  } catch {
    return false;
  }
};

const num = (v: number | undefined, dp = 1) => (v === undefined ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const rs = (v: number) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;

export interface AutoSignal {
  side: DaySide;
  candleTime: number;
  rPoints?: number;
  /** USIB's own TP2 (a chain level) and its trail */
  tp2?: number;
  trail?: number;
}

interface Props {
  strategy: "report-day" | "usib";
  /** where this release's record is kept */
  recordKey: string;
  /** the moment the day's clocks run from: the print (report day) or the US open (USIB) */
  releaseAt: number;
  /** the contract on the chart; the paper trade uses its mini */
  chartSymbol: string;
  signal?: AutoSignal;
  timeStop?: { fromMin: number; toMin: number };
  bars: readonly DayBar[];
  /** how often the trade is looked at, in ms (tests use a short one) */
  tickMs?: number;
  /** a toast, a sound and a desktop notice, once for each message */
  onEvent: (message: string) => void;
}

export function AutoPaper({ strategy, recordKey, releaseAt, chartSymbol, signal, timeStop, bars, tickMs = 2000, onEvent }: Props) {
  const label = strategy === "usib" ? "USIB" : "Report day";
  const clock = useClock();
  const symbol = autoSymbol(chartSymbol);
  const [armed, setArmed] = useState(loadArmed);
  const [rec, setRec] = useState<AutoRecord | undefined>(() => loadRec(recordKey));
  useEffect(() => setRec(loadRec(recordKey)), [recordKey]);
  const price = useStore((s) => s.quotes[symbol]?.price);

  // what the ticking loop below reads: always the latest props and record
  const latest = useRef({ armed, rec, signal, bars, releaseAt, timeStop, onEvent, recordKey, chartSymbol, strategy, label });
  latest.current = { armed, rec, signal, bars, releaseAt, timeStop, onEvent, recordKey, chartSymbol, strategy, label };
  const commit = (next: AutoRecord) => {
    saveRec(latest.current.recordKey, next);
    latest.current.rec = next; // the next tick sees it before the screen has redrawn
    setRec(next);
  };

  const busy = useRef(false);
  const polls = useRef(0);
  useEffect(() => {
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const L = latest.current;
        if (!L.rec) await enter(L);
        else if (L.rec.status === "placed") await manage(L);
      } finally {
        busy.current = false;
      }
    };
    const enter = async (L: typeof latest.current) => {
      const s = L.signal;
      if (!L.armed || !s) return;
      const skip = (reason: string) => {
        commit({ status: "skipped", reason, events: [] });
        L.onEvent(`${L.label}: auto paper trade skipped: ${reason}`);
      };
      if (!signalFresh(s.candleTime, DAY_RULES.candleSec, Date.now())) return skip("the signal is more than 2 minutes old, so it is not chased");
      const q = useStore.getState().quotes[autoSymbol(L.chartSymbol)];
      const ref = s.side === "long" ? (q?.ask ?? q?.price) : (q?.bid ?? q?.price);
      const planned = planAutoOrder({ chartSymbol: L.chartSymbol, dir: s.side, ref: ref ?? 0, rPoints: s.rPoints, tp2: L.strategy === "usib" ? s.tp2 : undefined });
      if (!planned.ok) return skip(planned.reason);
      const plan = planned.plan;
      const acct = await paperCall(`/accounts/${AUTO_ACCOUNT}`);
      if (!acct.ok && acct.status === 0) return; // the stream is unreachable: try again on the next tick
      if (!acct.ok && acct.status === 404) {
        const made = await paperCall("/accounts", "POST", { id: AUTO_ACCOUNT, capital: AUTO_CAPITAL, slippage: 1 });
        if (!made.ok) return made.status === 0 ? undefined : skip(`the auto account could not be created: ${made.error}`);
      }
      const r = await paperCall<{ position: { id: string; entry: number; openedAt: number } }>(`/accounts/${AUTO_ACCOUNT}/orders`, "POST", {
        symbol: plan.symbol,
        side: plan.side,
        lots: plan.lots,
        stop: plan.stop,
        ...(L.strategy === "report-day" ? { target: plan.tp2 } : {}), // USIB has no target: after TP2 the stop trails
        client_order_id: `auto-${L.recordKey}`.slice(0, 64),
        tag: "auto",
        strategy: L.strategy,
        signal_time: new Date((s.candleTime + DAY_RULES.candleSec) * 1000).toISOString(),
        r_points: plan.rPoints,
      });
      if (!r.ok) return r.status === 0 ? undefined : skip(`the paper order was refused: ${r.error}`);
      const pos = r.data.position;
      commit({
        status: "placed",
        symbol: plan.symbol,
        dir: plan.dir,
        lots: plan.lots,
        units: plan.units,
        entry: pos.entry,
        stop: plan.stop,
        tp1: plan.tp1,
        tp2: plan.tp2,
        rPoints: plan.rPoints,
        enteredAt: pos.openedAt,
        positionId: pos.id,
        currentStop: plan.stop,
        ...(L.strategy === "usib" && s.trail !== undefined ? { trail: s.trail } : {}),
        events: [],
      });
      L.onEvent(`${L.label}: paper ${plan.dir.toUpperCase()} opened, ${plan.lots} lot${plan.lots === 1 ? "" : "s"} ${plan.symbol} at ${num(pos.entry, 2)}, stop ${num(plan.stop, 2)}`);
    };
    const manage = async (L: typeof latest.current) => {
      let rec = L.rec!;
      const px = useStore.getState().quotes[rec.symbol!]?.price;
      const view = trackTrade(asManualTrade(rec, L.releaseAt, L.timeStop), L.bars, px, undefined, Date.now());
      if (view.fresh.length) {
        rec = { ...rec, events: view.events };
        commit(rec);
        for (const e of view.fresh) if (e.kind === "tp1" || e.kind === "tp2" || e.kind === "timestop-open") L.onEvent(`${L.label}: auto paper trade: ${AUTO_EVENT_TEXT[e.kind]}`);
      }
      const d = decideAuto(rec, view);
      const base = `/accounts/${AUTO_ACCOUNT}/positions/${encodeURIComponent(rec.positionId!)}`;
      if (d.closeTime) {
        const r = await paperCall<{ trade: { closedAt: number; exit: number; net: number } }>(`${base}/close`, "POST");
        if (r.ok) {
          commit({ ...rec, status: "closed", reason: "time exit", exit: { at: r.data.trade.closedAt, price: r.data.trade.exit, net: r.data.trade.net, reason: "time exit" } });
          L.onEvent(`${L.label}: auto paper trade closed at the time exit, net ${rs(r.data.trade.net)}`);
          return;
        }
        if (r.status === 404) polls.current = 99; // already closed on the server: the check below records how
      } else if (d.moveStop !== undefined) {
        const r = await paperCall(base, "PATCH", { stop: d.moveStop, only_tighten: true, reason: "auto: TP1 or trail" });
        if (r.ok) {
          rec = { ...rec, currentStop: d.moveStop };
          commit(rec);
        }
      }
      // closed on the server by the stop or the target while nobody was looking
      if (++polls.current >= 3) {
        polls.current = 0;
        const st = await paperCall<{ state: { positions: { id: string }[]; trades: { id: string; closedAt: number; exit: number; net: number; reason: string }[] } }>(`/accounts/${AUTO_ACCOUNT}`);
        if (st.ok && !st.data.state.positions.some((p) => p.id === rec.positionId)) {
          const t = st.data.state.trades.find((x) => x.id === rec.positionId);
          const why = t ? (t.reason === "stop" ? (rec.events.some((e) => e.kind === "tp1") ? "stopped at the entry" : "stopped out") : t.reason === "target" ? "target (TP2)" : t.reason) : "closed";
          commit({ ...rec, status: "closed", reason: why, ...(t ? { exit: { at: t.closedAt, price: t.exit, net: t.net, reason: why } } : {}) });
          L.onEvent(`${L.label}: auto paper trade closed: ${why}${t ? `, net ${rs(t.net)}` : ""}`);
        }
      }
    };
    const id = setInterval(() => void tick(), tickMs);
    void tick();
    return () => clearInterval(id);
  }, []);

  // the trade's levels on the chart while it is open
  usePublishLevels(
    `auto:${recordKey}`,
    rec?.status === "placed" && rec.entry !== undefined
      ? [
          { price: rec.entry, title: "Auto entry", color: "#e0e0e0", style: "solid" },
          { price: rec.currentStop ?? rec.stop ?? NaN, title: rec.currentStop !== undefined && rec.currentStop !== rec.stop ? "Auto stop (moved)" : "Auto stop", color: "#ef5350", style: "solid" },
          { price: rec.tp1 ?? NaN, title: "Auto TP1", color: "#66bb6a", style: "solid" },
          { price: rec.tp2 ?? NaN, title: "Auto TP2", color: "#43a047", style: "solid" },
        ]
      : [],
  );

  const toggle = (on: boolean) => {
    setArmed(on);
    try {
      localStorage.setItem(ARM_KEY, on ? "1" : "0");
    } catch {
      /* blocked: the switch holds for this session */
    }
  };

  const live = useMemo(() => {
    if (rec?.status !== "placed" || rec.entry === undefined || price === undefined) return undefined;
    const dir = rec.dir === "long" ? 1 : -1;
    return { pts: dir * (price - rec.entry), rs: dir * (price - rec.entry) * (rec.units ?? 1) * (rec.lots ?? 1) };
  }, [rec, price]);

  return (
    <section className="rd-auto" aria-label="Automatic paper trade" data-testid="auto-paper">
      <div className="rd-auto-head">
        <h2>Auto paper trade</h2>
        <label className="rd-auto-switch" title="When a signal fires, open, manage and close a simulated futures trade in the auto account. Nothing reaches a broker.">
          <Switch checked={armed} onCheckedChange={toggle} aria-label="Auto paper trade" /> {armed ? "On" : "Off"}
        </label>
      </div>
      {!rec && (
        <p className="muted">
          {armed
            ? `Armed: when a signal fires it opens a paper ${symbol} trade in the "${AUTO_ACCOUNT}" account (${rs(AUTO_CAPITAL)}), whole lots sized so the loss at the stop stays inside ${rs(DAY_RULES.lossCap)}. The stop is held by the server; this panel moves it to the entry at TP1${strategy === "usib" ? ", trails it after TP2" : ""} and closes at the time exit.`
            : "Off: nothing is traded automatically. Turn it on before the print; a signal that fired before you armed is skipped."}
        </p>
      )}
      {rec?.status === "skipped" && <p className="muted" data-testid="auto-skipped">Skipped: {rec.reason}</p>}
      {rec?.status === "placed" && (
        <div data-testid="auto-open">
          <p>
            <b className={rec.dir === "long" ? "up" : "down"}>{rec.dir?.toUpperCase()}</b> {rec.lots} lot{rec.lots === 1 ? "" : "s"} {rec.symbol} at <b>{num(rec.entry, 2)}</b> · {clock.time(rec.enteredAt ?? 0)}
          </p>
          <p className="muted">
            Stop {num(rec.currentStop, 2)}
            {rec.currentStop !== rec.stop ? " (moved)" : ""} · TP1 {num(rec.tp1, 2)}
            {strategy === "usib" ? " · after TP2 the stop trails" : ` · target ${num(rec.tp2, 2)}`} · R {num(rec.rPoints, 2)} points
          </p>
          {live && (
            <p className={live.rs >= 0 ? "up" : "down"}>
              {live.pts >= 0 ? "+" : ""}
              {num(live.pts, 2)} points · {rs(live.rs)} before costs
            </p>
          )}
        </div>
      )}
      {rec?.status === "closed" && (
        <p className={(rec.exit?.net ?? 0) >= 0 ? "up" : "down"} data-testid="auto-closed">
          Closed: {rec.reason}
          {rec.exit ? ` · net ${rs(rec.exit.net)} at ${num(rec.exit.price, 2)} · ${clock.time(rec.exit.at)}` : ""}. New entries are locked until the next release.
        </p>
      )}
    </section>
  );
}
