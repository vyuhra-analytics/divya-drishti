import type { RedisClient } from "bun";
import { dedupeNews, parseRss, tagNews, type NewsItem, type NewsTag } from "@drishti/shared";
import { newStats, poll, type ProviderStats } from "./providers/provider";

// Energy news from free RSS feeds, polled here once and pushed to every client (not polled per panel).
const EDITIONS = { IN: "hl=en-IN&gl=IN&ceid=IN:en", US: "hl=en-US&gl=US&ceid=US:en" };
const google = (q: string, ed: keyof typeof EDITIONS = "IN") =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${EDITIONS[ed]}`;
// tags: topic hint added to every item (the tagger still removes "crude" from palm/edible-oil stories).
// strict: keep only items whose headline itself has an energy keyword. Google matches article bodies, so broad
// searches return off-topic headlines ("2027 season"); Yahoo's CL=F feed is mostly general market news.
//
// Google News search returns ≤100 results ranked by relevance, not time, and only matches what the query says
// (a phrase list like "oil prices" missed "IEA … oil stocks release"). So: broad single-word queries, a
// last-hour window polled often for freshness, and a last-day window less often for breadth, in two editions.
const FEEDS: { name: string; url: string; tags: NewsTag[]; everyMs: number; strict?: boolean }[] = [
  { name: "Google News", url: google("oil when:1h"), tags: ["oil"], everyMs: 90_000, strict: true },
  { name: "Google News", url: google("oil when:1h", "US"), tags: ["oil"], everyMs: 90_000, strict: true },
  { name: "Google News", url: google("oil OR crude OR WTI OR Brent when:1d", "US"), tags: [], everyMs: 180_000, strict: true },
  { name: "Google News", url: google("IEA OR OPEC OR EIA oil when:1d"), tags: ["oil"], everyMs: 180_000, strict: true },
  // OpenTerminal's exact OIL sources (its /api/news?symbol=OIL): Google "OIL stock" (US) + Yahoo headlines for OIL
  { name: "Google News", url: google("OIL stock", "US"), tags: ["oil"], everyMs: 120_000, strict: true },
  { name: "Yahoo Finance", url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=OIL&region=US&lang=en-US", tags: [], everyMs: 120_000, strict: true },
  { name: "Google News", url: google('"natural gas" OR LNG OR "Henry Hub" when:1h', "US"), tags: ["natgas"], everyMs: 90_000 },
  { name: "Google News", url: google('"natural gas" OR LNG OR "Henry Hub" when:1d'), tags: ["natgas"], everyMs: 180_000 },
  { name: "Google News", url: google('"MCX crude" OR "MCX oil" OR "MCX natural gas" when:2d'), tags: ["india"], everyMs: 180_000 },
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", tags: [], everyMs: 60_000 },
  { name: "CNBC", url: "https://www.cnbc.com/id/19836768/device/rss/rss.html", tags: [], everyMs: 60_000 },
  { name: "Rigzone", url: "https://www.rigzone.com/news/rss/rigzone_latest.aspx", tags: [], everyMs: 60_000 },
  { name: "Yahoo Finance", url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=CL=F&region=US&lang=en-US", tags: [], everyMs: 60_000, strict: true },
  { name: "Yahoo Finance", url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=NG=F&region=US&lang=en-US", tags: [], everyMs: 60_000, strict: true },
  { name: "Economic Times", url: "https://economictimes.indiatimes.com/markets/commodities/rssfeeds/1808152121.cms", tags: ["india"], everyMs: 60_000 },
  { name: "EIA", url: "https://www.eia.gov/rss/press_rss.xml", tags: [], everyMs: 300_000 },
];
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0 Safari/537.36" };

export const newsStats: Record<string, ProviderStats> = {};
let items: NewsItem[] = [];
export const currentNews = () => items;

/** Starts all feeds; `publish` gets only items not seen before. */
export function startNews(redis: RedisClient, publish: (fresh: NewsItem[]) => void) {
  // a restart shouldn't blank the panel (best effort: Redis may be down)
  redis
    .get("news:latest")
    .then((raw) => raw && (items = dedupeNews(JSON.parse(raw), items)))
    .catch(() => {});

  const stops = FEEDS.map((feed, i) => {
    const key = `${feed.name} ${i}`;
    const stats = (newsStats[key] = newStats());
    // stagger first polls so ten feeds don't fire in the same second
    let stop = () => {};
    const timer = setTimeout(() => {
      stop = poll(feed.everyMs, stats, async () => {
        const res = await fetch(feed.url, { headers: UA, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`${res.status}`);
        const parsed = parseRss(await res.text(), feed.name, feed.tags).filter((n) => !feed.strict || tagNews(n.title).length > 0);
        const known = new Set(items.map((n) => n.id));
        items = dedupeNews(items, parsed);
        const fresh = items.filter((n) => !known.has(n.id));
        if (fresh.length) {
          publish(fresh);
          redis.set("news:latest", JSON.stringify(items)).catch(() => {});
        }
      });
    }, i * 1500);
    return () => {
      clearTimeout(timer);
      stop();
    };
  });
  return () => stops.forEach((s) => s());
}
