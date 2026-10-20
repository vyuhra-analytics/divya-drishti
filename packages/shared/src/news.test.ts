import { expect, test } from "bun:test";
import { dedupeNews, isSafeUrl, parseDate, parseRss, tagNews, type NewsItem } from "./news";

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
  expect(et.tags.sort()).toEqual(["crude", "india"]);

  const op = parseRss(OILPRICE, "OilPrice");
  expect(op).toHaveLength(1);
  expect(op[0]).toMatchObject({ title: "Chevron Moves to Take Over Russia's Iraqi Oil Field", publishedAt: Date.UTC(2026, 9, 20, 17, 0, 53) });
});

test("tagNews keyword rules", () => {
  expect(tagNews("OPEC+ agrees output cut")).toEqual(["crude"]);
  expect(tagNews("OIL prices jump as Hormuz tensions flare")).toEqual(["crude"]);
  expect(tagNews("Palm oil futures climb on export demand")).toEqual([]);
  expect(tagNews("India cuts edible oil import duty")).toEqual(["india"]);
  expect(tagNews("Brent rises while palm oil slips")).toEqual(["crude"]);
  expect(tagNews("Palm oil prices in Malaysia rise to four-week high", ["crude"])).toEqual([]); // crude feed hint overridden
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
  expect(merged[1]).toMatchObject({ source: "A", publishedAt: now - 20 * 60_000 });
  expect(merged[1].tags.sort()).toEqual(["crude", "india"]);
});

test("parseDate and isSafeUrl", () => {
  expect(parseDate("Fri, 09 Oct  09:00:00 EST")).toBeNaN(); // EIA's year-less date: skipped, not guessed
  expect(isSafeUrl("https://a.b")).toBe(true);
  expect(isSafeUrl("data:text/html,x")).toBe(false);
});
