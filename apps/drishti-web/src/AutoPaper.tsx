import { useEffect, useRef, useState } from "react";
import { AUTO_ACCOUNT, AUTO_CAPITAL, closedWhy, DAY_RULES, optionOrderBody, signalFresh, type AutoRecord, type DaySide, type OptionLegSignal } from "@drishti/shared";
import { paperCall } from "./paperClient";
import { useClock } from "./settings";
import { sendWatch, useStore } from "./store";
import { Switch } from "./ui";

// The automatic PAPER trade of a signal (report day and USIB). The signal is read on the future, but the trade is the OPTION the strategies buy: when a signal
// fires and the switch is on, the option leg (a call for a long, a put for a short, one lot) is bought in the separate "auto" paper account. The server holds
// the premium stop and (report day) the TP2 target, moves the stop to the entry at TP1, trails it in USIB and closes at the time exit, all with this browser
// closed; this component places the order, watches the contract and tells the trader what happened. Simulated only: no broker is ever reached. A signal armed
// too late is skipped, never chased. The pure parts are in shared autoTrade.ts and optionSignal.ts.

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
/** On unless the trader has switched it off: the choice is kept in the browser ("0" = off). */
const loadArmed = () => {
  try {
    return localStorage.getItem(ARM_KEY) !== "0";
  } catch {
    return true;
  }
};

const num = (v: number | undefined, dp = 1) => (v === undefined ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const rs = (v: number) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;

export interface AutoSignal {
  side: DaySide;
  candleTime: number;
}

interface Props {
  strategy: "report-day" | "usib";
  /** where this release's record is kept */
  recordKey: string;
  /** the moment the day's clocks run from: the print (report day) or the US open (USIB) */
  releaseAt: number;
  signal?: AutoSignal;
  /** the option to buy for the signal (optionLegFor), or why there is none */
  option?: OptionLegSignal;
  optionReason?: string;
  timeStop?: { fromMin: number; toMin: number };
  /** how often the trade is looked at, in ms (tests use a short one) */
  tickMs?: number;
  /** a toast, a sound and a desktop notice, once for each message */
  onEvent: (message: string) => void;
}

export function AutoPaper({ strategy, recordKey, releaseAt, signal, option, optionReason, timeStop, tickMs = 2000, onEvent }: Props) {
  const label = strategy === "usib" ? "USIB" : "Report day";
  const clock = useClock();
  const [armed, setArmed] = useState(loadArmed);
  const [rec, setRec] = useState<AutoRecord | undefined>(() => loadRec(recordKey));
  useEffect(() => setRec(loadRec(recordKey)), [recordKey]);
  const bid = useStore((s) => (rec?.optionKey ? s.options[rec.optionKey]?.bid : undefined));

  // what the ticking loop below reads: always the latest props and record
  const latest = useRef({ armed, rec, signal, option, optionReason, releaseAt, timeStop, onEvent, recordKey, strategy, label });
  latest.current = { armed, rec, signal, option, optionReason, releaseAt, timeStop, onEvent, recordKey, strategy, label };
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
        else if (L.rec.status === "placed") await watch(L);
      } finally {
        busy.current = false;
      }
    };
    const enter = async (L: typeof latest.current) => {
      const s = L.signal;
      if (!L.armed || !s) return;
      const skip = (reason: string) => {
        commit({ status: "skipped", reason });
        L.onEvent(`${L.label}: auto paper trade skipped: ${reason}`);
      };
      if (!signalFresh(s.candleTime, DAY_RULES.candleSec, Date.now())) return skip("the signal is more than 2 minutes old, so it is not chased");
      const leg = L.option;
      if (!leg?.key) return skip(L.optionReason ?? "no option fits this signal");
      sendWatch([leg.key]); // the stream must be listening to the contract before a paper order can be priced
      const acct = await paperCall(`/accounts/${AUTO_ACCOUNT}`);
      if (!acct.ok && acct.status === 0) return; // the stream is unreachable: try again on the next tick
      if (!acct.ok && acct.status === 404) {
        const made = await paperCall("/accounts", "POST", { id: AUTO_ACCOUNT, capital: AUTO_CAPITAL, slippage: 1 });
        if (!made.ok) return made.status === 0 ? undefined : skip(`the auto account could not be created: ${made.error}`);
      }
      const r = await paperCall<{ position: { id: string; entry: number; openedAt: number } }>(
        `/accounts/${AUTO_ACCOUNT}/orders`,
        "POST",
        optionOrderBody(leg, { strategy: L.strategy, recordKey: L.recordKey, candleTime: s.candleTime, releaseAt: L.releaseAt, timeStop: L.timeStop }),
      );
      // no live premium yet: the stream has just been asked to watch the contract, so try again on the next tick (the freshness rule ends the tries)
      if (!r.ok && (r.status === 0 || (r.status === 503 && /premium|try again/i.test(r.error)))) return;
      if (!r.ok) return skip(`the paper order was refused: ${r.error}`);
      const pos = r.data.position;
      commit({
        status: "placed",
        label: leg.label,
        optionKey: leg.key,
        dir: s.side,
        lots: 1,
        units: leg.units,
        entry: pos.entry,
        stop: leg.stop,
        currentStop: leg.stop,
        tp1: leg.tp1,
        tp2: leg.tp2,
        rPremium: leg.rPremium,
        enteredAt: pos.openedAt,
        positionId: pos.id,
      });
      L.onEvent(`${L.label}: paper bought 1 lot ${leg.label} at ${num(pos.entry, 2)}, stop ${num(leg.stop, 2)}, TP1 ${num(leg.tp1, 2)}`);
    };
    // the server runs the trade; every few seconds read the account to see the stop move and the trade close
    const watch = async (L: typeof latest.current) => {
      sendWatch([L.rec!.optionKey!]);
      if (++polls.current < 3) return;
      polls.current = 0;
      let rec = L.rec!;
      const st = await paperCall<{ state: { positions: { id: string; stop?: number; plan?: { tp1Done?: boolean } }[]; trades: { id: string; closedAt: number; exit: number; net: number; reason: string }[] } }>(`/accounts/${AUTO_ACCOUNT}`);
      if (!st.ok) return;
      const open = st.data.state.positions.find((p) => p.id === rec.positionId);
      if (open) {
        if (open.plan?.tp1Done && !rec.tp1Done) L.onEvent(`${L.label}: auto paper trade: TP1 reached, the stop moved to the entry`);
        if (open.stop !== rec.currentStop || (open.plan?.tp1Done ?? false) !== (rec.tp1Done ?? false)) commit({ ...rec, currentStop: open.stop, tp1Done: open.plan?.tp1Done ?? false });
        return;
      }
      const t = st.data.state.trades.find((x) => x.id === rec.positionId);
      const why = t ? closedWhy(t.reason, rec.tp1Done ?? false) : "closed";
      rec = { ...rec, status: "closed", reason: why, ...(t ? { exit: { at: t.closedAt, price: t.exit, net: t.net, reason: why } } : {}) };
      commit(rec);
      L.onEvent(`${L.label}: auto paper trade closed: ${why}${t ? `, net ${rs(t.net)}` : ""}`);
    };
    const id = setInterval(() => void tick(), tickMs);
    void tick();
    return () => clearInterval(id);
  }, []);

  const toggle = (on: boolean) => {
    setArmed(on);
    try {
      localStorage.setItem(ARM_KEY, on ? "1" : "0");
    } catch {
      /* blocked: the switch holds for this session */
    }
  };

  const live = rec?.status === "placed" && rec.entry !== undefined && bid !== undefined ? { pts: bid - rec.entry, rs: (bid - rec.entry) * (rec.units ?? 1) * (rec.lots ?? 1) } : undefined;

  return (
    <section className="rd-auto" aria-label="Automatic paper trade" data-testid="auto-paper">
      <div className="rd-auto-head">
        <h2>Auto paper trade</h2>
        <label className="rd-auto-switch" title="When a signal fires, buy the signal's option on paper, manage it and close it, in the auto account. Nothing reaches a broker.">
          <Switch checked={armed} onCheckedChange={toggle} aria-label="Auto paper trade" /> {armed ? "On" : "Off"}
        </label>
      </div>
      {signal && !rec && (
        <p data-testid="auto-option-signal" className={option ? undefined : "muted"}>
          {option ? (
            <>
              <b>Option signal:</b> buy <b className={option.type === "CE" ? "up" : "down"}>{option.label}</b> at {num(option.premium, 2)} (delta {num(option.delta, 2)}) · stop {num(option.stop, 2)} · TP1 {num(option.tp1, 2)} · TP2 {num(option.tp2, 2)} · 1R {rs(option.rupeeR)} · lot costs {rs(option.cost)}
            </>
          ) : (
            <>Option signal: none. {optionReason}</>
          )}
        </p>
      )}
      {!rec && (
        <p className="muted">
          {armed
            ? `Armed: when a signal fires it buys the signal's option (a call for a long, a put for a short, one lot) in the "${AUTO_ACCOUNT}" account (${rs(AUTO_CAPITAL)}), strike picked so 1R stays inside ${rs(DAY_RULES.lossCap)}. The server holds the stop${strategy === "usib" ? "" : " and the target"}, moves it to the entry at TP1${strategy === "usib" ? ", trails it after TP2" : ""} and closes at the time exit.`
            : "Off: nothing is traded automatically. Turn it on before the print; a signal that fired before you armed is skipped."}
        </p>
      )}
      {rec?.status === "skipped" && <p className="muted" data-testid="auto-skipped">Skipped: {rec.reason}</p>}
      {rec?.status === "placed" && (
        <div data-testid="auto-open">
          <p>
            <b className={rec.dir === "long" ? "up" : "down"}>BOUGHT</b> {rec.lots} lot {rec.label} at <b>{num(rec.entry, 2)}</b> · {clock.time(rec.enteredAt ?? 0)}
          </p>
          <p className="muted">
            Stop {num(rec.currentStop, 2)}
            {rec.currentStop !== rec.stop ? " (moved)" : ""} · TP1 {num(rec.tp1, 2)}
            {strategy === "usib" ? " · after TP2 the stop trails" : ` · target ${num(rec.tp2, 2)}`} · 1R {num(rec.rPremium, 2)} premium points
          </p>
          {live && (
            <p className={live.rs >= 0 ? "up" : "down"}>
              {live.pts >= 0 ? "+" : ""}
              {num(live.pts, 2)} premium · {rs(live.rs)} at the bid, before costs
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
