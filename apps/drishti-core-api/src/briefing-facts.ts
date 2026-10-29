import { agreement, buildContext, chainProvenance, buildRecap, completedBars, freshness, fxSession, instrument, mcxSession, nymexSession, recapExtras, SYMBOLS, TIMEFRAMES, TOPIC_TAGS, type Bar, type CotRow, type CurveSummary, type EiaSummary, type BriefingContext, type CalEvent, type Chain, type DayOverride, type NewsItem, type Quote, type Timeframe } from "@drishti/shared";

export interface StreamHealth {
  active?: Record<string, string>;
  prices?: Record<string, Record<string, { price: number; at: number; delayedBy?: number }>>;
  providers?: Record<string, { ok: number; failed: number; lastError: string | null; lastOkAt: number | null; latencyMs: number | null }>;
  rejected?: { count: number };
}

const API_PORT = process.env.API_PORT ?? 3001;
const STREAM = `http://127.0.0.1:${process.env.STREAM_PORT ?? 3002}`;

/** The real sources: this API's own routes over loopback, and the stream's health. */
export const liveSources: Sources = {
  api: (path) => fetch(`http://127.0.0.1:${API_PORT}${path}`, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined) as never,
  health: () => fetch(`${STREAM}/health`, { signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined) as never,
  now: Date.now,
};

/** How the facts are fetched: the API's own routes and the stream's health. Replaceable so the assembly is tested without a network. */
export interface Sources {
  /** this API's own route, e.g. "/bars?symbol=…" (undefined on any failure) */
  api<T>(path: string): Promise<T | undefined>;
  /** the stream service's /health */
  health(): Promise<StreamHealth | undefined>;
  now(): number;
}

/**
 * The same facts the Briefing panel gathers in the browser, gathered on the server: live quote, completed bars (indicators are computed from
 * them), headlines for the instrument's topic, scheduled releases, MCX options positioning, and whether the feed is live. The trader's own
 * position is never included here: it would leave this machine in an agent's context.
 */
export async function gatherServerContext(symbol: string, tf: string, s: Sources): Promise<BriefingContext> {
  const inst = instrument(symbol);
  if (!inst) throw new Error(`unknown symbol ${symbol}`);
  const now = s.now();
  const tags = inst.topic ? TOPIC_TAGS[inst.topic] : [];
  const [quote, bars, news, events, chain, health, day] = await Promise.all([
    s.api<Quote>(`/quotes/${encodeURIComponent(symbol)}`),
    s.api<Bar[]>(`/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`),
    s.api<NewsItem[]>(`/news?limit=15${tags.length ? `&tags=${tags.join(",")}` : ""}`),
    s.api<CalEvent[]>("/calendar?days=2"),
    inst.exchange === "MCX" && inst.upstox ? s.api<Chain>(`/options?underlying=${inst.upstox}`) : Promise.resolve(undefined),
    s.health(),
    inst.exchange === "MCX" ? s.api<{ mcx: DayOverride | null }>("/market/sessions") : Promise.resolve(undefined),
  ]);
  if (!quote) throw new Error(`no live price for ${symbol} yet`);

  const open = inst.exchange === "MCX" ? mcxSession(now, day?.mcx ?? undefined).open : inst.exchange === "NYMEX" ? nymexSession(now).open : fxSession(now).open;
  const active = health?.active?.[symbol];
  const heardAt = active ? health?.prices?.[symbol]?.[active]?.at : undefined; // any poll counts as heard, even with an unchanged price

  return buildContext({
    symbol,
    quote,
    // only bars that have closed: the forming bar is not final
    bars: completedBars(bars ?? [], TIMEFRAMES[tf as Timeframe] ?? 300, now / 1000).slice(-200),
    timeframe: tf,
    freshness: freshness(open, heardAt, now),
    news: news ?? [],
    events: events ?? [],
    options: chain ? { expiry: chain.expiry, pcr: chain.pcr, maxPain: chain.maxPain, spot: chain.spot } : undefined,
    optionsProvenance: chain ? chainProvenance(chain, freshness(open, heardAt, now), now) : undefined,
    now,
  });
}

/** Just the computed numbers of the briefing context (indicators, volatility, regime) with where the price comes from. */
export async function technicals(symbol: string, tf: string, s: Sources) {
  const c = await gatherServerContext(symbol, tf, s);
  return { symbol: c.symbol, name: c.name, asOf: c.asOf, price: c.price, changePct: c.changePct, day: c.day, provenance: { price: c.provenance.price, technicals: c.provenance.technicals }, technicals: c.technicals, stats: c.stats };
}

/** The plain-language recap (no AI), built from the same context plus the curve, positioning and inventory lines. Energy futures only. */
export async function recap(symbol: string, s: Sources) {
  const inst = instrument(symbol);
  if (!inst) throw new Error(`unknown symbol ${symbol}`);
  if (inst.exchange === "FX") throw new Error("The recap covers the energy futures: pick an MCX or NYMEX contract.");
  const crude = inst.topic === "crude";
  const [ctx, curve, cot, eia] = await Promise.all([
    gatherServerContext(symbol, "5m", s),
    s.api<{ summary?: CurveSummary }>(`/curve?symbol=${encodeURIComponent(symbol)}`),
    s.api<{ rows: CotRow[] }>(`/cot?market=${crude ? "wti" : "natgas"}&weeks=156`),
    crude ? s.api<{ series: (EiaSummary & { label: string })[] }>("/eia") : Promise.resolve(undefined),
  ]);
  return { symbol, asOf: ctx.asOf, ...buildRecap(ctx, recapExtras({ crude, curve, cot, eia })) };
}

/**
 * Market state for every tracked instrument: is its exchange open, which feed serves it, is it live or stale, do the feeds agree, and
 * how each data provider is doing. What a person reads off the status bar and the data-quality panel, in one place.
 */
export async function marketStatus(s: Sources) {
  const now = s.now();
  const [health, day] = await Promise.all([s.health(), s.api<{ mcx: DayOverride | null }>("/market/sessions")]);
  const sessions = { MCX: mcxSession(now, day?.mcx ?? undefined), NYMEX: nymexSession(now), FX: fxSession(now) };
  const instruments = SYMBOLS.map((symbol) => {
    const inst = instrument(symbol)!;
    const open = sessions[inst.exchange].open;
    const active = health?.active?.[symbol];
    const prices = health?.prices?.[symbol] ?? {};
    const heardAt = active ? prices[active]?.at : undefined;
    const ag = agreement(symbol, prices, now);
    return {
      symbol,
      name: inst.name,
      exchange: inst.exchange,
      session: open ? "open" : "closed",
      quality: freshness(open, heardAt, now), // live, stale (open but silent over a minute) or closed
      feed: active ?? null,
      heardSecondsAgo: heardAt ? Math.round((now - heardAt) / 1000) : null,
      delayedSeconds: inst.delayedBy,
      agreement: ag.sources.length < 2 ? "one feed only (no comparison)" : ag.drifting ? "DRIFTING" : "agree",
      ...(ag.gap ? { gap: { ticks: ag.gap.ticks, pct: Number(ag.gap.pct.toFixed(3)), between: ag.gap.between } } : {}),
    };
  });
  return {
    asOf: new Date(now).toISOString(),
    sessions: Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, { open: v.open, nextChange: v.next ? new Date(v.next).toISOString() : null }])),
    instruments,
    feeds: Object.fromEntries(Object.entries(health?.providers ?? {}).map(([k, v]) => [k, { ok: v.ok, failed: v.failed, lastError: v.lastError, lastHeardSecondsAgo: v.lastOkAt ? Math.round((now - v.lastOkAt) / 1000) : null }])),
    rejectedQuotes: health?.rejected?.count ?? 0,
    ...(health ? {} : { warning: "The stream service is not reachable: feed state is unknown." }),
  };
}
