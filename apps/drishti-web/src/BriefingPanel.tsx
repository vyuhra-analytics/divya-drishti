import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  buildContext,
  chainProvenance,
  completedBars,
  instrument,
  positionContext,
  scoreBriefing,
  TIMEFRAMES,
  TOPIC_TAGS,
  type Bar,
  type BriefingResult,
  type CalEvent,
  type Chain,
  type GroundingReport,
  type PointCheck,
  type OpenPosition,
  type Timeframe,
} from "@drishti/shared";
import { apiUrl, useClock, useSettings } from "./settings";
import { useStore } from "./store";
import { symbolFreshness, useNow } from "./market";
import { useWidgetSymbol, type Widget } from "./workspace";
import { Button } from "./ui";

interface Entry {
  id: string;
  symbol: string;
  at: number;
  priceThen: number;
  model: string;
  result: BriefingResult;
  /** how the points held up against the data, checked by code (absent on briefings saved before this existed) */
  grounding?: GroundingReport;
  /** model calls used; 2 = the first answer cited something wrong and was corrected once */
  attempts?: number;
  /** "mcp" = written by Claude over MCP and submitted to the app, not by our own model call */
  via?: "mcp";
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

/** Briefings Claude submitted over MCP (stored by the API with their checked verdicts) join the journal, here and in any other open browser. */
function useSubmittedBriefings() {
  const rev = useStore((s) => s.briefingRev);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${apiUrl()}/briefing/submitted?limit=10`);
        if (!res.ok || !alive) return;
        const rows = (await res.json()) as { id: string; symbol: string; at: number; priceThen: number; result: BriefingResult; grounding: GroundingReport }[];
        useJournal.setState((s) => {
          const have = new Set(s.entries.map((e) => e.id));
          const fresh: Entry[] = rows.filter((r) => !have.has(r.id)).map((r) => ({ id: r.id, symbol: r.symbol, at: r.at, priceThen: r.priceThen, model: "Claude (MCP)", result: r.result, grounding: r.grounding, via: "mcp" }));
          return fresh.length ? { entries: [...fresh, ...s.entries].sort((a, b) => b.at - a.at).slice(0, 30) } : s;
        });
      } catch {
        /* the API is not reachable: nothing new to show */
      }
    };
    void load();
    const t = setInterval(load, 60_000); // the stream announces a submission at once; this only covers a missed announcement
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [rev]);
}
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
    inst?.exchange === "MCX" && inst.upstox ? json<Chain>(`/options?underlying=${inst.upstox}`) : Promise.resolve(undefined),
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
    optionsProvenance: chain ? chainProvenance(chain, symbolFreshness(symbol), Date.now()) : undefined,
    now: Date.now(),
  });
}

const MARK = {
  verified: { sym: "✓", cls: "up", label: "Checked against the data" },
  wrong: { sym: "✗", cls: "down", label: "Contradicts the data" },
  unverified: { sym: "?", cls: "muted", label: "Could not be fully checked" },
} as const;

function Points({ title, items, cls, checks }: { title: string; items: BriefingResult["bull"]; cls: string; checks?: PointCheck[] }) {
  return (
    <section className={`brief-col ${cls}`}>
      <h2>{title}</h2>
      {items.length === 0 && <p className="muted">None found in the data.</p>}
      <ul>
        {items.map((p, i) => {
          const c = checks?.find((x) => x.index === i);
          const m = c && MARK[c.verdict];
          return (
            <li key={i} className={c?.verdict === "wrong" ? "brief-wrong" : undefined}>
              {m && (
                <span className={`brief-mark ${m.cls}`} role="img" aria-label={m.label} title={[m.label, ...c.issues.map((x) => x.text)].join("\n")}>
                  {m.sym}
                </span>
              )}{" "}
              {p.point}
              <small className="muted"> · {p.evidence}</small>
              {c?.issues.filter((x) => x.kind === "wrong").map((x, k) => (
                <small key={k} className="down brief-issue">
                  Data says: {x.text}
                </small>
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One line on how the briefing held up when code checked every cited figure against the data it was written from. */
function GroundingNote({ g, attempts }: { g?: GroundingReport; attempts?: number }) {
  if (!g) return <p className="muted brief-ground">Not checked against the data (saved before checking existed).</p>;
  return (
    <div className="brief-ground">
      <span className={g.wrong ? "down" : g.verified === g.total ? "up" : "muted"}>
        {g.verified} of {g.total} points checked against the data
      </span>
      {g.wrong > 0 && <span className="down"> · {g.wrong} contradict{g.wrong === 1 ? "s" : ""} it</span>}
      {attempts === 2 && <span className="muted"> · corrected once after a mismatch</span>}
      {g.other.map((o, i) => (
        <small key={i} className="muted brief-issue">
          Summary: {o.text}
        </small>
      ))}
    </div>
  );
}

/** AI briefing: bull case, bear case and a bias from the live data, plus a journal that grades past calls. Research aid only. */
export function BriefingWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const clock = useClock();
  const now = useNow(60_000);
  const price = useStore((s) => s.quotes[symbol]?.price);
  const { entries, add, clear } = useJournal();
  useSubmittedBriefings();
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
      const entry: Entry = { id: `b-${body.generatedAt}`, symbol, at: body.generatedAt, priceThen: context.price, model: body.model, result: body.result, grounding: body.grounding, attempts: body.attempts };
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
        <Button size="sm" onClick={generate} disabled={busy}>
          {busy ? "Writing…" : `Brief me on ${symbol.split(":")[1]}`}
        </Button>
        <span className="muted brief-note">One AI call, or two if a citation has to be corrected (about US$0.05 each). Research aid, not advice.</span>
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
            <GroundingNote g={shown.grounding} attempts={shown.attempts} />
            <div className="brief-cols">
              <Points title="Bull case" items={r.bull} cls="bull" checks={shown.grounding?.points.filter((p) => p.section === "bull")} />
              <Points title="Bear case" items={r.bear} cls="bear" checks={shown.grounding?.points.filter((p) => p.section === "bear")} />
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
            <p className="muted brief-foot">{shown.via === "mcp" ? "Written by Claude over MCP and submitted to the app" : `Written by ${shown.model}`} from data as of {clock.stamp(shown.at)}. May be wrong: check the evidence.</p>
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
