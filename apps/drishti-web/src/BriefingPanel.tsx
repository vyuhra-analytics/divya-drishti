import { useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  buildContext,
  completedBars,
  instrument,
  positionContext,
  scoreBriefing,
  TIMEFRAMES,
  TOPIC_TAGS,
  type Bar,
  type BriefingResult,
  type CalEvent,
  type OpenPosition,
  type Timeframe,
} from "@drishti/shared";
import { apiUrl, useClock, useSettings } from "./settings";
import { useStore } from "./store";
import { symbolFreshness, useNow } from "./market";
import { useWidgetSymbol, type Widget } from "./workspace";

interface Entry {
  id: string;
  symbol: string;
  at: number;
  priceThen: number;
  model: string;
  result: BriefingResult;
}

/** Past briefings, kept in this browser so they can be graded later against what price did. */
export const useJournal = create<{ entries: Entry[]; add: (e: Entry) => void; clear: () => void }>()(
  persist(
    (set) => ({
      entries: [],
      add: (e) => set((s) => ({ entries: [e, ...s.entries].slice(0, 30) })),
      clear: () => set({ entries: [] }),
    }),
    { name: "drishti-briefings", version: 1 },
  ),
);

const GRADE_AFTER_MS = 30 * 60_000;
const json = async <T,>(path: string): Promise<T | undefined> => {
  try {
    const res = await fetch(`${apiUrl()}${path}`);
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
};

/** Collect what the briefing may use: live quote, recent bars (indicators are computed from them), headlines, releases, options. */
export async function gatherContext(symbol: string, tf: string, withPosition = false) {
  const quote = useStore.getState().quotes[symbol];
  if (!quote) throw new Error("No live price for this instrument yet");
  const inst = instrument(symbol);
  const topicTags = inst?.topic ? TOPIC_TAGS[inst.topic] : [];
  const [bars, events, chain, held] = await Promise.all([
    json<Bar[]>(`/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`),
    json<CalEvent[]>("/calendar?days=2"),
    inst?.exchange === "MCX" && inst.upstox ? json<{ expiry: string; pcr?: number; maxPain?: number; spot?: number }>(`/options?underlying=${inst.upstox}`) : Promise.resolve(undefined),
    withPosition && inst?.exchange === "MCX" ? json<{ positions: OpenPosition[] }>("/positions") : Promise.resolve(undefined),
  ]);
  const news = useStore.getState().news;
  const relevant = topicTags.length ? news.filter((n) => n.tags.some((t) => topicTags.includes(t))) : news;
  return buildContext({
    symbol,
    quote,
    // only bars that have closed: the forming bar is not final, and the facts must not change while it fills
    bars: completedBars(bars ?? [], TIMEFRAMES[tf as Timeframe] ?? 300, Date.now() / 1000).slice(-200),
    timeframe: tf,
    freshness: symbolFreshness(symbol),
    news: relevant,
    events: events ?? [],
    // opted in: a failed read is "unavailable", not "flat". Not opted in (or NYMEX, which Upstox does not carry): nothing is sent
    position: withPosition && inst?.exchange === "MCX" ? positionContext(symbol, held?.positions) : undefined,
    options: chain ? { expiry: chain.expiry, pcr: chain.pcr, maxPain: chain.maxPain, spot: chain.spot } : undefined,
    now: Date.now(),
  });
}

function Points({ title, items, cls }: { title: string; items: BriefingResult["bull"]; cls: string }) {
  return (
    <section className={`brief-col ${cls}`}>
      <h2>{title}</h2>
      {items.length === 0 && <p className="muted">None found in the data.</p>}
      <ul>
        {items.map((p, i) => (
          <li key={i}>
            {p.point}
            <small className="muted"> · {p.evidence}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** AI briefing: bull case, bear case and a bias from the live data, plus a journal that grades past calls. Research aid only. */
export function BriefingWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const clock = useClock();
  const now = useNow(60_000);
  const price = useStore((s) => s.quotes[symbol]?.price);
  const { entries, add, clear } = useJournal();
  const sharePosition = useSettings((s) => s.briefingPositions);
  const set = useSettings((s) => s.set);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownId, setShownId] = useState<string | null>(null);

  const shown = entries.find((e) => e.id === shownId) ?? entries.find((e) => e.symbol === symbol) ?? null;

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const context = await gatherContext(symbol, widget.tf, sharePosition);
      const res = await fetch(`${apiUrl()}/briefing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ context }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      const entry: Entry = { id: `b-${body.generatedAt}`, symbol, at: body.generatedAt, priceThen: context.price, model: body.model, result: body.result };
      add(entry);
      setShownId(entry.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const r = shown?.result;
  return (
    <div className="brief">
      <div className="toolbar no-drag">
        <button className="btn" onClick={generate} disabled={busy}>
          {busy ? "Writing…" : `Brief me on ${symbol.split(":")[1]}`}
        </button>
        <span className="muted brief-note">One AI call (about US$0.05). Research aid, not advice.</span>
        {instrument(symbol)?.exchange === "MCX" && (
          <label className="brief-share" title="Sends your net quantity, average price and P&L in this contract to the AI service with the briefing">
            <input type="checkbox" checked={sharePosition} onChange={(e) => set({ briefingPositions: e.target.checked })} /> Include my position
          </label>
        )}
      </div>
      <div className="brief-body" tabIndex={0} role="region" aria-label="Briefing">
        {error && <p className="down brief-error">{error}</p>}
        {!r && !error && <p className="empty muted">Press the button for a bull and bear case built from the live price, indicators, headlines and scheduled releases.</p>}
        {r && shown && (
          <>
            <div className="brief-head">
              <span className={`brief-bias ${r.bias}`}>{r.bias.toUpperCase()}</span>
              <span className="muted">{r.confidence} confidence</span>
              <span className="muted brief-time">
                {shown.symbol.split(":")[1]} · {clock.stamp(shown.at)}
              </span>
            </div>
            <p className="brief-summary">{r.summary}</p>
            <div className="brief-cols">
              <Points title="Bull case" items={r.bull} cls="bull" />
              <Points title="Bear case" items={r.bear} cls="bear" />
            </div>
            {r.watch.length > 0 && (
              <section>
                <h2>Watch next</h2>
                <ul>{r.watch.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </section>
            )}
            {r.data_gaps.length > 0 && (
              <section>
                <h2>Missing data</h2>
                <ul className="muted">{r.data_gaps.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </section>
            )}
            <p className="muted brief-foot">Written by {shown.model} from data as of {clock.stamp(shown.at)}. May be wrong: check the evidence.</p>
          </>
        )}

        {entries.length > 0 && (
          <section className="brief-journal">
            <h2>
              Journal <button className="linklike" onClick={() => confirm("Clear the briefing journal?") && clear()}>clear</button>
            </h2>
            {entries.map((e) => {
              const live = e.symbol === symbol ? price : undefined;
              const graded = live !== undefined && now - e.at >= GRADE_AFTER_MS ? scoreBriefing(e.result.bias, e.priceThen, live) : null;
              return (
                <button key={e.id} className={`journal-row${e.id === shown?.id ? " active" : ""}`} onClick={() => setShownId(e.id)}>
                  <span className="muted">{clock.stamp(e.at)}</span>
                  <span>{e.symbol.split(":")[1]}</span>
                  <span className={`brief-bias ${e.result.bias}`}>{e.result.bias}</span>
                  <span className="journal-score muted">
                    {graded ? (
                      <>
                        <span className={graded.hit ? "up" : "down"}>{graded.hit ? "right" : "wrong"}</span> {graded.movePct >= 0 ? "+" : ""}
                        {graded.movePct.toFixed(2)}%
                      </>
                    ) : live === undefined ? "open this symbol to grade" : "too early to grade"}
                  </span>
                </button>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}
