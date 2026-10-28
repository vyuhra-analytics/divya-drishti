import { useEffect, useMemo, useState } from "react";
import { DAY_RULES, gaugePosition, reviewTrade, suggestedReason, trackTrade, type ClosedTrade, type DayBar, type DaySignal, type ManualTrade, type StrikePick, type TradeEvent, type TradeExitReason } from "@drishti/shared";
import { sendWatch, useStore } from "./store";
import { useClock } from "./settings";
import { loadRecord, saveRecord, type DayRecord } from "./reportDayStore";
import { usePublishLevels } from "./strategyLevels";
import { paperCall } from "./paperClient";
import { Button, Input, Select } from "./ui";

// The in-trade and done stages of the report-day screen: the trader says when they entered and exited (by hand: no order is ever placed here), and the
// screen follows the trade in between: the future against entry / stop / TP1 / TP2, the result in R, the option's rupee result against the loss cap, the
// clock against the time stop, and alerts at each milestone. Afterwards a review with a note box; new entries stay locked until the next release.

const JOURNAL_KEY = "drishti-rd-journal";
const journalPref = () => {
  try {
    return localStorage.getItem(JOURNAL_KEY) === "1";
  } catch {
    return false;
  }
};
const paperAccount = () => {
  try {
    return localStorage.getItem("drishti-paper-account") || "main";
  } catch {
    return "main";
  }
};

const num = (v: number | undefined, dp = 1) => (v === undefined ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const rs = (v: number) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
const REASONS: Record<TradeExitReason, string> = { stop: "Stopped out", tp1: "Took profit at TP1", tp2: "Took profit at TP2", cap: "The ₹2,000 cap", time: "Time stop", manual: "By hand" };

const EVENT_TEXT: Record<TradeEvent["kind"], string> = {
  tp1: "TP1 reached: move the stop to your entry",
  tp2: "TP2 reached: take the rest (USIB: the stop now trails)",
  stop: "STOP level reached: get out",
  cap: `The loss has reached the ₹${DAY_RULES.lossCap.toLocaleString("en-IN")} cap: get out`,
  "timestop-open": "The time stop window has opened: exit by the end of it",
  timestop: "TIME STOP: exit now",
};

/** what the entry form needs of a signal: the report-day's or USIB's */
export type TradeSignal = Pick<DaySignal, "side" | "candleTime" | "entry" | "rPoints"> & { tp2?: number; trail?: number };

interface Props {
  /** the moment the day's clocks run from: the print (report day) or the US open (USIB) */
  releaseAt: number;
  /** where the record is kept; the print's time for the report day, "usib:" + the open's time for USIB */
  recordKey?: number | string;
  /** USIB: the time stop window in minutes after `releaseAt` */
  timeStop?: { fromMin: number; toMin: number };
  symbol: string;
  /** the signal and the strike suggested for it, to prefill the entry */
  signal?: TradeSignal;
  pick?: StrikePick;
  /** units per lot of the option */
  units: number;
  bars: readonly DayBar[];
  now: number;
  /** a bid for the pick's strike from the polled chain, used until the live option quote arrives */
  chainBid?: (strike: number, side: "long" | "short") => number | undefined;
  /** called once for every milestone (the panel turns it into a toast and a sound) */
  onEvent: (message: string) => void;
}

export function ReportDayTrade({ releaseAt, recordKey, timeStop, symbol, signal, pick, units, bars, now, chainBid, onEvent }: Props) {
  const key = recordKey ?? releaseAt;
  const clock = useClock();
  const [rec, setRec] = useState<DayRecord>(() => loadRecord(key));
  const [entering, setEntering] = useState(false);
  const [exiting, setExiting] = useState(false);
  useEffect(() => setRec(loadRecord(key)), [key]);
  const update = (patch: Partial<DayRecord>) => setRec(saveRecord(key, patch));

  const trade = rec.trade;
  const releaseLabel = typeof key === "string" && key.startsWith("usib") ? "USIB" : "Report day";
  const price = useStore((s) => s.quotes[symbol]?.price);
  const liveOption = useStore((s) => (trade?.optionKey ? s.options[trade.optionKey] : undefined));
  // follow the option's own live quote while the trade is open (the stream drops a contract nobody asked for in 60 s)
  useEffect(() => {
    if (!trade?.optionKey || rec.closed) return;
    sendWatch([trade.optionKey]);
    const id = setInterval(() => sendWatch([trade.optionKey!]), 20_000);
    return () => clearInterval(id);
  }, [trade?.optionKey, !!rec.closed]);

  const optionBid = trade ? (liveOption?.bid && liveOption.bid > 0 ? liveOption.bid : (chainBid?.(trade.strike, trade.side) ?? liveOption?.price)) : undefined;
  const view = useMemo(() => (trade && !rec.closed ? trackTrade(trade, bars, price, optionBid, now) : undefined), [trade, rec.closed, bars, price, optionBid, Math.floor(now / 1000)]);

  // the trade's own levels on the chart while it is open: the entry, the stop in force (it moves to the entry and then trails), TP1 and TP2
  usePublishLevels(
    `trade:${key}`,
    trade && !rec.closed
      ? [
          { price: trade.futureEntry, title: "Your entry", color: "#e0e0e0", style: "solid" },
          { price: view?.stop ?? trade.stop, title: view?.trailing ? "Stop (trailing)" : view?.stopAtEntry ? "Stop (at entry)" : "Stop 1R", color: "#ef5350", style: "solid" },
          { price: trade.tp1, title: "TP1", color: "#66bb6a", style: "solid" },
          { price: trade.tp2, title: "TP2", color: "#43a047", style: "solid" },
        ]
      : [],
  );

  // a new milestone is saved with the trade (so a reload does not repeat it) and announced once
  useEffect(() => {
    if (!trade || !view || view.fresh.length === 0) return;
    update({ trade: { ...trade, events: view.events } });
    for (const e of view.fresh) onEvent(`${releaseLabel}: ${EVENT_TEXT[e.kind]}`);
  }, [view?.fresh.length, view?.events.length]);

  // ---- done: the review
  if (rec.closed) {
    const c = rec.closed;
    const r = reviewTrade(c);
    return (
      <section className="rd-trade" aria-label="Trade review">
        <h2>Done: review</h2>
        <p className={r.pnl >= 0 ? "up" : "down"}>
          <b>{rs(r.pnl)}</b> on the option ({num(r.optionPct, 0)}% of the premium){r.rResult !== undefined && <> · <b>{num(r.rResult, 1)}R</b> against 1R ≈ {rs((r.pnl / r.rResult) || 0)}</>}
        </p>
        <table className="bt-num rd-table">
          <tbody>
            <tr><td>Trade</td><td>{c.side.toUpperCase()} {c.strike} {c.side === "long" ? "CE" : "PE"} × {c.lots} lot</td></tr>
            <tr><td>Entered</td><td>{clock.time(c.enteredAt)} at {num(c.premium, 1)} (future {num(c.futureEntry, 1)})</td></tr>
            <tr><td>Exited</td><td>{clock.time(c.exitedAt)} at {num(c.exitPremium, 1)} · {REASONS[c.reason]}</td></tr>
            <tr><td>Held</td><td>{r.heldMinutes} minutes</td></tr>
            <tr><td>The future reached</td><td>{[r.reached.tp1 && "TP1", r.reached.tp2 && "TP2", r.reached.stop && "the stop", r.reached.cap && "the cap"].filter(Boolean).join(", ") || "none of the levels"}</td></tr>
          </tbody>
        </table>
        <label className="rd-note-box">
          <span className="muted">Note</span>
          <textarea defaultValue={c.note} rows={3} placeholder="What you saw, what you would change" onBlur={(e) => update({ closed: { ...c, note: e.target.value } })} aria-label="Trade note" />
        </label>
        <p className="muted">New entries are locked until the next release.</p>
      </section>
    );
  }

  // ---- in trade
  if (trade && view) {
    const dir = trade.side === "long" ? 1 : -1;
    const level = (v: number) => num(v, 1);
    const reason = suggestedReason(view);
    const slice = view.timeStop.state === "window" ? "window" : view.timeStop.state === "past" ? "past" : "before";
    return (
      <section className="rd-trade rd-live" aria-label="Trade in progress">
        <h2>In trade: {trade.side.toUpperCase()} {trade.strike} {trade.side === "long" ? "CE" : "PE"}</h2>
        {view.events.filter((e) => e.kind !== "timestop-open").slice(-1).map((e) => (
          <p key={e.kind} className="rd-flash down">{EVENT_TEXT[e.kind]}</p>
        ))}
        <div className="rd-pnl">
          <div>
            <div className="muted">Option (at the bid)</div>
            <div className={`rd-big ${view.pnl === undefined ? "" : view.pnl >= 0 ? "up" : "down"}`}>{view.pnl === undefined ? "—" : rs(view.pnl)}</div>
            <div className="muted">bought {num(trade.premium, 1)} · bid {num(view.optionBid, 1)}</div>
          </div>
          <div>
            <div className="muted">Result in R</div>
            <div className={`rd-big ${view.rMultiple >= 0 ? "up" : "down"}`}>{view.rMultiple >= 0 ? "+" : ""}{num(view.rMultiple, 2)}R</div>
            <div className="muted">future {num(price, 1)} · {view.move >= 0 ? "+" : ""}{num(view.move, 1)} pts</div>
          </div>
        </div>
        <div className="rd-gauge" role="img" aria-label={`Result ${num(view.rMultiple, 2)} R between the stop at minus 1 R and TP2 at plus 2 R`}>
          <span className="rd-tick" style={{ left: "0%" }}>stop −1R</span>
          <span className="rd-tick" style={{ left: "33.3%" }}>entry</span>
          <span className="rd-tick" style={{ left: "66.7%" }}>TP1 +1R</span>
          <span className="rd-tick" style={{ left: "100%" }}>TP2</span>
          <i className="rd-mark" style={{ left: `${gaugePosition(view.rMultiple) * 100}%` }} />
        </div>
        <table className="bt-num rd-table">
          <tbody>
            <tr><td>Stop</td><td>{level(view.stop)}</td><td className="muted">{view.trailing ? `trailing ${trade.trail !== undefined ? num(trade.trail, 1) : ""} points under the best close` : view.stopAtEntry ? "moved to your entry" : `${dir === 1 ? "below" : "above"} your entry`}</td></tr>
            <tr><td>Entry (future)</td><td>{level(trade.futureEntry)}</td><td className="muted">R = {num(trade.rPoints, 1)} points</td></tr>
            <tr className={view.events.some((e) => e.kind === "tp1") ? "up" : ""}><td>TP1</td><td>{level(trade.tp1)}</td><td className="muted">{view.events.some((e) => e.kind === "tp1") ? "reached" : `${num(Math.abs(trade.tp1 - (price ?? trade.futureEntry)), 1)} away`}</td></tr>
            <tr className={view.events.some((e) => e.kind === "tp2") ? "up" : ""}><td>TP2</td><td>{level(trade.tp2)}</td><td className="muted">{view.events.some((e) => e.kind === "tp2") ? "reached" : `${num(Math.abs(trade.tp2 - (price ?? trade.futureEntry)), 1)} away`}</td></tr>
          </tbody>
        </table>
        {trade.delta !== undefined && (
          <p className="muted" title="R translated to the option through the delta read at entry, fixed there: the premium levels to place as real orders if you want them">
            Option premium levels (R × delta {num(Math.abs(trade.delta), 2)}): stop <b>{num(trade.premium - trade.rPoints * Math.abs(trade.delta), 1)}</b> · TP1 <b>{num(trade.premium + trade.rPoints * Math.abs(trade.delta), 1)}</b> · TP2 <b>{num(trade.premium + 2 * trade.rPoints * Math.abs(trade.delta), 1)}</b>
          </p>
        )}
        <p className={view.capHit ? "down" : "muted"}>
          Loss cap {rs(DAY_RULES.lossCap)}: {view.pnl === undefined ? "no option price yet" : view.pnl >= 0 ? "in profit" : `${rs(-view.pnl)} lost (${num((-view.pnl / DAY_RULES.lossCap) * 100, 0)}% of the cap)`}
          {view.rupeeR !== undefined && <> · 1R ≈ {rs(view.rupeeR)}</>}
        </p>
        <p className={slice === "before" ? "muted" : "down"}>
          Time stop: {clock.time(view.timeStop.opensAt)} to {clock.time(view.timeStop.hardAt)}
          {slice === "before" ? ` (${Math.max(0, Math.round((view.timeStop.opensAt - now) / 60_000))} min to the window)` : slice === "window" ? ` · the window is open: ${Math.max(0, Math.round((view.timeStop.hardAt - now) / 60_000))} min left` : " · PAST: exit now"}
        </p>
        {exiting ? (
          <ExitForm
            defaultPremium={view.optionBid}
            defaultReason={reason}
            onCancel={() => setExiting(false)}
            canLog={!!trade.optionKey}
            onSubmit={(exitPremium, why, log) => {
              const closed: ClosedTrade = { ...trade, events: view.events, exitedAt: Date.now(), exitPremium, reason: why, note: "" };
              update({ closed });
              setExiting(false);
              if (log && trade.optionKey) {
                // the same trade, in the paper journal at the premiums the trader says (nothing is priced or filled there); the id makes a repeat harmless
                const account = paperAccount();
                void paperCall(`/accounts/${encodeURIComponent(account)}/trades`, "POST", {
                  option: { key: trade.optionKey },
                  lots: trade.lots,
                  entry: trade.premium,
                  exit: exitPremium,
                  openedAt: trade.enteredAt,
                  closedAt: closed.exitedAt,
                  reason: why === "stop" ? "stop" : "manual",
                  strategy: releaseLabel === "USIB" ? "usib" : "report-day",
                  client_order_id: `${releaseLabel === "USIB" ? "usib" : "rd"}-${trade.enteredAt}`,
                  note: REASONS[why],
                }).then((r) => onEvent(r.ok ? `${releaseLabel}: recorded in the paper journal (${account})` : `${releaseLabel}: not recorded in the journal: ${r.error}`));
              }
            }}
          />
        ) : (
          <Button variant="default" size="sm" onClick={() => setExiting(true)}>I exited the trade</Button>
        )}
        <p className="muted">This only follows the trade. The order is placed and closed by you.</p>
      </section>
    );
  }

  // ---- no trade yet: offer to record one once there is a signal
  if (!signal) return null;
  return (
    <section className="rd-trade" aria-label="Record the trade">
      <h2>Your trade</h2>
      {entering ? (
        <EnterForm
          signal={signal}
          pick={pick}
          units={units}
          price={price}
          timeStop={timeStop}
          onCancel={() => setEntering(false)}
          onSubmit={(t) => {
            update({ trade: { ...t, releaseAt, events: [] } });
            setEntering(false);
          }}
        />
      ) : (
        <>
          <Button variant="default" size="sm" onClick={() => setEntering(true)}>I entered this trade</Button>
          <p className="muted">Press it after you have placed the order, with the price you got: the screen then follows the stop, the targets, the cap and the time stop.</p>
        </>
      )}
    </section>
  );
}

function EnterForm({ signal, pick, units, price, timeStop, onSubmit, onCancel }: { signal: TradeSignal; pick?: StrikePick; units: number; price?: number; timeStop?: { fromMin: number; toMin: number }; onSubmit: (t: Omit<ManualTrade, "releaseAt" | "events">) => void; onCancel: () => void }) {
  const [future, setFuture] = useState(String(signal.entry ?? price ?? ""));
  const [strike, setStrike] = useState(String(pick?.strike ?? ""));
  const [premium, setPremium] = useState(String(pick?.premium ?? ""));
  const [lots, setLots] = useState("1");
  // a price that arrives after the form opened fills a field the trader has not touched
  useEffect(() => {
    setFuture((v) => (v === "" && (signal.entry ?? price) !== undefined ? String(signal.entry ?? price) : v));
    setStrike((v) => (v === "" && pick ? String(pick.strike) : v));
    setPremium((v) => (v === "" && pick ? String(pick.premium) : v));
  }, [signal.entry, price, pick?.strike, pick?.premium]);
  const f = Number(future);
  const p = Number(premium);
  const s = Number(strike);
  const l = Math.floor(Number(lots));
  const r = signal.rPoints;
  const ok = Number.isFinite(f) && f > 0 && Number.isFinite(p) && p > 0 && Number.isFinite(s) && s > 0 && l >= 1 && r !== undefined;
  return (
    <form
      className="rd-form no-drag"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok || r === undefined) return;
        const dir = signal.side === "long" ? 1 : -1;
        const tp1 = f + dir * r;
        const tp2 = signal.tp2 !== undefined && dir * (signal.tp2 - tp1) > 0 ? signal.tp2 : f + dir * 2 * r; // USIB brings a chain level; otherwise 2R
        onSubmit({ enteredAt: Date.now(), side: signal.side, futureEntry: f, rPoints: r, stop: f - dir * r, tp1, tp2, trail: signal.trail, timeStop, strike: s, optionKey: pick && pick.strike === s ? pick.key : undefined, premium: p, units, lots: l, delta: pick && pick.strike === s ? pick.delta : undefined });
      }}
    >
      <label>Future entry price<Input inputMode="decimal" value={future} onChange={(e) => setFuture(e.target.value)} /></label>
      <label>Option strike<Input inputMode="decimal" value={strike} onChange={(e) => setStrike(e.target.value)} /></label>
      <label>Premium paid<Input inputMode="decimal" value={premium} onChange={(e) => setPremium(e.target.value)} /></label>
      <label>Lots<Input inputMode="numeric" value={lots} onChange={(e) => setLots(e.target.value)} /></label>
      <div className="rd-form-actions">
        <Button type="submit" variant="default" size="sm" disabled={!ok}>Follow this trade</Button>
        <Button type="button" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      {r === undefined && <p className="muted">R is not known yet (the candles before the signal are too few).</p>}
    </form>
  );
}

function ExitForm({ defaultPremium, defaultReason, canLog, onSubmit, onCancel }: { defaultPremium?: number; defaultReason: TradeExitReason; canLog: boolean; onSubmit: (premium: number, reason: TradeExitReason, log: boolean) => void; onCancel: () => void }) {
  const [log, setLog] = useState(journalPref);
  const [premium, setPremium] = useState(defaultPremium === undefined ? "" : String(defaultPremium));
  const [reason, setReason] = useState<TradeExitReason>(defaultReason);
  const p = Number(premium);
  const ok = Number.isFinite(p) && p >= 0 && premium.trim() !== "";
  return (
    <form
      className="rd-form no-drag"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSubmit(p, reason, canLog && log);
      }}
    >
      <label>Premium you sold at<Input inputMode="decimal" value={premium} onChange={(e) => setPremium(e.target.value)} /></label>
      <label>
        Why
        <Select value={reason} onChange={(e) => setReason(e.target.value as TradeExitReason)}>
          {(Object.keys(REASONS) as TradeExitReason[]).map((k) => (
            <option key={k} value={k}>{REASONS[k]}</option>
          ))}
        </Select>
      </label>
      {canLog && (
        <label className="rd-check">
          <input
            type="checkbox"
            checked={log}
            onChange={(e) => {
              setLog(e.target.checked);
              try {
                localStorage.setItem(JOURNAL_KEY, e.target.checked ? "1" : "0");
              } catch {}
            }}
          />
          Also record it in the paper journal
        </label>
      )}
      <div className="rd-form-actions">
        <Button type="submit" variant="default" size="sm" disabled={!ok}>Close the record</Button>
        <Button type="button" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
