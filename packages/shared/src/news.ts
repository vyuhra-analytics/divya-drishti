/**
 * crude: crude-market words (crude, WTI, Brent, OPEC, barrels, refineries…).
 * oil: any "oil" headline (oil prices, oil stocks, IEA oil reserves, oil majors) — what OpenTerminal's OIL search returns.
 */
export type NewsTag = "crude" | "oil" | "natgas" | "india";

/** Tags a linked panel shows for an instrument's commodity. */
export const TOPIC_TAGS: Record<"crude" | "natgas", NewsTag[]> = { crude: ["crude", "oil"], natgas: ["natgas"] };

export interface NewsItem {
  /** normalized-title hash: the same story from several feeds collapses to one item */
  id: string;
  title: string;
  url: string;
  /** publisher (from Google News <source>, else the feed's name) */
  source: string;
  publishedAt: number;
  tags: NewsTag[];
  /**
   * Every later outlet that ran the identical headline, each with its own link and time, oldest first
   * (wire stories: a Reuters headline on marketscreener, Zawya, The Standard…). The item itself is the first report.
   */
  copies?: NewsCopy[];
}

export interface NewsCopy {
  source: string;
  url: string;
  publishedAt: number;
}

export const NEWS_MAX_COPIES = 30;

export const NEWS_TAGS: NewsTag[] = ["crude", "oil", "natgas", "india"];

/** Row of the Postgres `news` archive (infra/sql/003_news.sql). */
export interface NewsRow {
  id: string;
  title: string;
  url: string;
  source: string;
  published_at: Date | string;
  tags: string[];
  copies: NewsCopy[] | null;
}

export const newsFromRow = (r: NewsRow): NewsItem => ({
  id: r.id,
  title: r.title,
  url: r.url,
  source: r.source,
  publishedAt: new Date(r.published_at).getTime(),
  tags: r.tags.filter((t): t is NewsTag => (NEWS_TAGS as string[]).includes(t)),
  ...(r.copies?.length ? { copies: r.copies } : {}),
});

export const NEWS_MAX = 600; // broad oil searches fill 300 well inside the 48 h window
export const NEWS_MAX_AGE_MS = 48 * 3600_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(\w+);/g, (m, e) => ENTITIES[e] ?? m)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

const field = (item: string, tag: string) => item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1];

/** RFC-822 dates, or ISO-ish dates without a zone (taken as UTC). NaN when unparseable. */
export function parseDate(s: string): number {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) return Date.parse(`${t.replace(" ", "T")}Z`);
  // engines invent a year when it's missing (EIA's "Fri, 09 Oct 09:00:00 EST" → 2001); refuse instead
  return /\b\d{4}\b/.test(t) ? Date.parse(t) : NaN;
}

/** Only http(s) links are ever opened; a feed can't smuggle in javascript: or data: URLs. */
export const isSafeUrl = (url: string) => /^https?:\/\//i.test(url);

/** Story identity: lowercase alphanumerics of the title, without Google's " - Publisher" suffix. */
export function storyKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 80);
}

/** FNV-1a: short stable id from the story key (no crypto needed for dedupe) */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// "oil" alone also matches edible/industrial oils; those headlines are neither oil-market nor crude news
const NOT_CRUDE_OIL = /\b(palm|edible|cooking|olive|vegetable|soy(bean)?|mustard|sunflower|coconut|essential|castor|groundnut)\s+oils?\b/i;

const RULES: [NewsTag, RegExp][] = [
  ["crude", /\b(crude|wti|brent|opec\+?|refiner(y|ies)|barrels?|petroleum|gasoline|diesel|shale|hormuz)\b/i],
  // oil-market vocabulary beyond the word itself: majors, inventories, rigs, the IEA
  ["oil", /\b(oils?|exxon(mobil)?|chevron|aramco|conocophillips|occidental|petrobras|totalenergies|shell plc|bp plc|inventor(y|ies)|stockpiles?|rig counts?|iea)\b/i],
  ["natgas", /\b(natural gas|nat ?gas|lng|henry hub|gas storage|gas prices?|ttf|natgas(mini)?)\b/i],
  ["india", /\b(mcx|india|indian|rupee|ongc|reliance|nse|sebi)\b/i],
];

/** Keyword tags from the headline, plus the feed's own topic (a natural-gas search result is natgas news). */
export function tagNews(title: string, feedTags: NewsTag[] = []): NewsTag[] {
  const tags = new Set(feedTags);
  for (const [tag, re] of RULES) if (re.test(title)) tags.add(tag);
  // palm/edible oil stories aren't oil-market news, even from an "oil" search feed
  if (NOT_CRUDE_OIL.test(title)) {
    tags.delete("oil");
    if (!/\b(crude|wti|brent|opec)\b/i.test(title)) tags.delete("crude");
  }
  return [...tags];
}

/** RSS 2.0 → items. Skips entries without a usable title, safe link or date. */
export function parseRss(xml: string, feedName: string, feedTags: NewsTag[] = []): NewsItem[] {
  const out: NewsItem[] = [];
  for (const item of xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? []) {
    const publisher = decode(field(item, "source") ?? "") || feedName;
    let title = decode(field(item, "title") ?? "");
    // Google News appends " - Publisher" to every title
    if (publisher !== feedName && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3));
    const url = decode(field(item, "link") ?? "");
    const publishedAt = parseDate(decode(field(item, "pubDate") ?? ""));
    if (!title || !isSafeUrl(url) || !Number.isFinite(publishedAt)) continue;
    out.push({ id: hash(storyKey(title)), title, url, source: publisher, publishedAt, tags: tagNews(title, feedTags) });
  }
  return out;
}

const asCopy = ({ source, url, publishedAt }: NewsItem | NewsCopy): NewsCopy => ({ source, url, publishedAt });

/**
 * One story seen twice: the earliest copy stays the headline row (publisher, link and time belong together) and
 * every copy is kept in `copies`, one per outlet (an outlet re-sent by another feed keeps its earliest time).
 */
function mergeCopies(a: NewsItem, b: NewsItem): NewsItem {
  const byOutlet = new Map<string, NewsCopy>();
  for (const c of [a, ...(a.copies ?? []), b, ...(b.copies ?? [])].map(asCopy)) {
    const seen = byOutlet.get(c.source);
    if (!seen || c.publishedAt < seen.publishedAt) byOutlet.set(c.source, c);
  }
  const [first, ...later] = [...byOutlet.values()].sort((x, y) => x.publishedAt - y.publishedAt);
  return {
    ...(first.publishedAt === a.publishedAt && first.source === a.source ? a : b),
    ...first,
    tags: [...new Set([...a.tags, ...b.tags])],
    ...(later.length ? { copies: later.slice(0, NEWS_MAX_COPIES) } : { copies: undefined }),
  };
}

/**
 * Merge new items into the list: one entry per story (the earliest copy, every other outlet in `copies`, tags unioned),
 * newest first, max NEWS_MAX, nothing older than NEWS_MAX_AGE_MS.
 */
export function dedupeNews(existing: NewsItem[], incoming: NewsItem[], now = Date.now()): NewsItem[] {
  const byId = new Map(existing.map((n) => [n.id, n]));
  for (const n of incoming) {
    const old = byId.get(n.id);
    byId.set(n.id, old ? mergeCopies(old, n) : n);
  }
  return [...byId.values()]
    .filter((n) => n.publishedAt > now - NEWS_MAX_AGE_MS && n.publishedAt < now + 5 * 60_000) // drop stale and bogus-future dates
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, NEWS_MAX);
}
