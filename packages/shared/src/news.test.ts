import { expect, test } from "bun:test";
import { dedupeNews, isSafeUrl, newsFromRow, parseDate, parseRss, tagNews, type NewsItem } from "./news";

// Trimmed real shapes: Google News (source tag, " - Publisher" suffix), Economic Times (CDATA + trailing space),
// OilPrice (numeric entity), Investing-style zone-less date, plus junk that must be skipped.
const GOOGLE = `<rss><channel>
<item><title>European natural gas prices top &#8364;90 per MWh - Investing.com India</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Tue, 20 Oct 2026 16:40:00 GMT</pubDate><source url="https://in.investing.com">Investing.com India</source></item>
<item><title>Bad link story</title><link>javascript:alert(1)</link><pubDate>Tue, 20 Oct 2026 16:40:00 GMT</pubDate></item>
</channel></rss>`;
const ET = `<item><title><![CDATA[Oil Price Today: Crude nears $110 &amp; MCX rises]]> </title><link>https://economictimes.indiatimes.com/x.cms</link><pubDate>Tue, 20 Oct 2026 08:30:00 +0530</pubDate></item>`;
const OILPRICE = `<item>
  <title>Chevron Moves to Take Over Russia&#039;s Iraqi Oil Field</title>
  <link>https://oilprice.com/a.html</link>
  <pubDate>2026-10-20 17:00:53</pubDate>
</item>
<item><title>No date</title><link>https://x.com</link></item>`;

test("parseRss handles Google source/suffix, CDATA, entities, zone-less dates, and skips unsafe/undated", () => {
  const [g, ...rest] = parseRss(GOOGLE, "Google News", ["natgas"]);
  expect(rest).toEqual([]); // javascript: link dropped
  expect(g).toMatchObject({
    title: "European natural gas prices top €90 per MWh",
    source: "Investing.com India",
    url: "https://news.google.com/rss/articles/abc?oc=5",
    publishedAt: Date.UTC(2026, 9, 20, 16, 40),
    tags: ["natgas"],
  });

  const [et] = parseRss(ET, "Economic Times");
  expect(et.title).toBe("Oil Price Today: Crude nears $110 & MCX rises");
  expect(et.publishedAt).toBe(Date.UTC(2026, 9, 20, 3, 0));
  expect(et.tags.sort()).toEqual(["crude", "india", "oil"]);

  const op = parseRss(OILPRICE, "OilPrice");
  expect(op).toHaveLength(1);
  expect(op[0]).toMatchObject({ title: "Chevron Moves to Take Over Russia's Iraqi Oil Field", publishedAt: Date.UTC(2026, 9, 20, 17, 0, 53) });
});

test("tagNews keyword rules", () => {
  expect(tagNews("OPEC+ agrees output cut")).toEqual(["crude"]);
  expect(tagNews("OIL prices jump as Hormuz tensions flare").sort()).toEqual(["crude", "oil"]); // Hormuz is crude-market
  expect(tagNews("IEA ready to go if further oil stocks release needed")).toEqual(["oil"]);
  expect(tagNews("Murphy Oil stock hits 52-week high")).toEqual(["oil"]);
  expect(tagNews("ExxonMobil Hits a New All-Time High")).toEqual(["oil"]);
  expect(tagNews("Inventories: Warning Sign in Decelerating Stock Draws")).toEqual(["oil"]);
  expect(tagNews("U.S. Stocks Turn Higher, Setting Aside AI Jitters")).toEqual([]);
  expect(tagNews("Brent crude slips below $110")).toEqual(["crude"]);
  expect(tagNews("Palm oil futures climb on export demand")).toEqual([]);
  expect(tagNews("India cuts edible oil import duty")).toEqual(["india"]);
  expect(tagNews("Brent rises while palm oil slips")).toEqual(["crude"]);
  expect(tagNews("Palm oil prices in Malaysia rise to four-week high", ["oil"])).toEqual([]); // oil feed hint overridden
  expect(tagNews("Henry Hub futures slide on storage build")).toEqual(["natgas"]);
  expect(tagNews("Tech stocks rally")).toEqual([]);
  expect(tagNews("Tech stocks rally", ["india"])).toEqual(["india"]);
});

test("dedupeNews collapses the same story, keeps earliest time, unions tags, drops stale, sorts newest first", () => {
  const now = Date.UTC(2026, 9, 20, 17);
  const item = (id: string, minsAgo: number, tags: NewsItem["tags"] = [], source = "A"): NewsItem => ({
    id,
    title: id,
    url: `https://x/${id}`,
    source,
    publishedAt: now - minsAgo * 60_000,
    tags,
  });
  const merged = dedupeNews([item("a", 10, ["crude"]), item("old", 60 * 49)], [item("a", 20, ["india"], "B"), item("b", 1)], now);
  expect(merged.map((n) => n.id)).toEqual(["b", "a"]);
  // earliest copy kept whole (B's source, url and time together), A listed as a later publisher
  expect(merged[1]).toMatchObject({ source: "B", url: "https://x/a", publishedAt: now - 20 * 60_000 });
  expect(merged[1].copies).toEqual([{ source: "A", url: "https://x/a", publishedAt: now - 10 * 60_000 }]);
  expect(merged[1].tags.sort()).toEqual(["crude", "india"]);
});

test("dedupeNews: wire story seen first from a late republisher is corrected when the earlier copy arrives", () => {
  const now = Date.UTC(2026, 9, 20, 15);
  const wire = (source: string, utcH: number, m: number): NewsItem => ({
    id: "iea", title: "IEA ready to go if further oil stocks release needed, chief says", url: `https://${source}/x`,
    source, publishedAt: Date.UTC(2026, 9, 20, utcH, m), tags: ["oil"],
  });
  const first = dedupeNews([], [wire("The Standard (HK)", 13, 52)], now);
  const merged = dedupeNews(first, [wire("marketscreener.com", 10, 35), wire("Zawya", 11, 55)], now);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ source: "marketscreener.com", url: "https://marketscreener.com/x", publishedAt: Date.UTC(2026, 9, 20, 10, 35) });
  // every outlet kept with its own link and time, oldest first
  expect(merged[0].copies).toEqual([
    { source: "Zawya", url: "https://Zawya/x", publishedAt: Date.UTC(2026, 9, 20, 11, 55) },
    { source: "The Standard (HK)", url: "https://The Standard (HK)/x", publishedAt: Date.UTC(2026, 9, 20, 13, 52) },
  ]);
  // the same outlet arriving again from another feed doesn't add a duplicate copy
  expect(dedupeNews(merged, [wire("Zawya", 11, 55)], now)[0].copies).toHaveLength(2);
});

test("parseDate and isSafeUrl", () => {
  expect(parseDate("Fri, 09 Oct  09:00:00 EST")).toBeNaN(); // EIA's year-less date: skipped, not guessed
  expect(isSafeUrl("https://a.b")).toBe(true);
  expect(isSafeUrl("data:text/html,x")).toBe(false);
});

test("newsFromRow maps archive rows and drops unknown tags", () => {
  const row = { id: "x", title: "T", url: "https://a/x", source: "A", published_at: "2026-10-20T10:35:00Z", tags: ["oil", "bogus"], copies: null };
  expect(newsFromRow(row)).toEqual({ id: "x", title: "T", url: "https://a/x", source: "A", publishedAt: Date.UTC(2026, 9, 20, 10, 35), tags: ["oil"] });
  const copies = [{ source: "B", url: "https://b/x", publishedAt: 1 }];
  expect(newsFromRow({ ...row, copies }).copies).toEqual(copies);
});
