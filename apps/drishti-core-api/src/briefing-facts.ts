import { buildContext, completedBars, freshness, fxSession, instrument, mcxSession, nymexSession, TIMEFRAMES, TOPIC_TAGS, type Bar, type BriefingContext, type CalEvent, type DayOverride, type NewsItem, type Quote, type Timeframe } from "@drishti/shared";

/** How the facts are fetched: the API's own routes and the stream's health. Replaceable so the assembly is tested without a network. */
export interface Sources {
  /** this API's own route, e.g. "/bars?symbol=…" (undefined on any failure) */
  api<T>(path: string): Promise<T | undefined>;
  /** the stream service's /health */
  health(): Promise<{ active?: Record<string, string>; prices?: Record<string, Record<string, { at: number }>> } | undefined>;
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
    inst.exchange === "MCX" && inst.upstox ? s.api<{ expiry: string; pcr?: number; maxPain?: number; spot?: number }>(`/options?underlying=${inst.upstox}`) : Promise.resolve(undefined),
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
    now,
  });
}
