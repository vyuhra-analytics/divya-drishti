import { useEffect, useState } from "react";
import { instrument, isSafeUrl, matchesQuery, TOPIC_TAGS, type NewsItem, type NewsTag } from "@drishti/shared";
import { useStore } from "./store";
import { apiUrl, useClock, useSettings } from "./settings";
import { useWidgetSymbol, type Widget } from "./workspace";
import { Button, Input } from "./ui";

type Filter = "linked" | "all" | NewsTag;
const FILTERS: [Filter, string][] = [
  ["linked", "Linked"],
  ["all", "All"],
  ["crude", "Crude"],
  ["oil", "Oil"],
  ["natgas", "Nat Gas"],
  ["india", "India"],
];
const TAG_LABEL: Record<NewsTag, string> = { crude: "CRUDE", oil: "OIL", natgas: "NAT GAS", india: "INDIA" };
const NEW_MS = 2 * 60_000;

const ago = (t: number, now: number) => {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

/** Re-render every 30 s so "3m ago" and NEW markers stay honest without new items arriving. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const CHIPS_SHOWN = 4;

function Row({ n, now, flash, stampOf }: { n: NewsItem; now: number; flash: boolean; stampOf: (t: number) => string }) {
  const [all, setAll] = useState(false);
  const stamp = stampOf(n.publishedAt);
  const fresh = now - n.publishedAt < NEW_MS;
  // parseRss already drops non-http(s) links; checked again because this is where a click happens
  const link = (url: string) => (isSafeUrl(url) ? url : undefined);
  // every outlet that ran this headline, first report first; one chip each, pick where to read
  const outlets = n.copies?.length ? [{ source: n.source, url: n.url, publishedAt: n.publishedAt }, ...n.copies] : [];
  const shown = all ? outlets : outlets.slice(0, CHIPS_SHOWN);
  return (
    <div className={`news-row${fresh && flash ? " news-fresh" : ""}`}>
      <span className="news-time">{ago(n.publishedAt, now)}</span>
      <span className="news-body">
        <a className="news-title" href={link(n.url)} target="_blank" rel="noopener noreferrer" title={`${n.title}
${n.source} · ${stamp}`}>
          {fresh && <span className="news-new">NEW</span>}
          {n.title}
        </a>
        <span className="news-meta">
          {outlets.length === 0 && <span>{n.source}</span>}
          <time dateTime={new Date(n.publishedAt).toISOString()}>{stamp}</time>
          {n.tags.map((t) => (
            <span key={t} className={`news-tag tag-${t}`}>
              {TAG_LABEL[t]}
            </span>
          ))}
        </span>
        {outlets.length > 0 && (
          <span className="news-outlets" aria-label={`Published by ${outlets.length} outlets`}>
            {shown.map((o, i) => (
              <a
                key={o.source}
                className={i === 0 ? "outlet first" : "outlet"}
                href={link(o.url)}
                target="_blank"
                rel="noopener noreferrer"
                title={`${o.source} · ${stampOf(o.publishedAt)}${i === 0 ? " · first report" : ` · +${ago(n.publishedAt, o.publishedAt)} after first`}`}
              >
                {o.source}
              </a>
            ))}
            {outlets.length > CHIPS_SHOWN && (
              <button className="outlet more" onClick={() => setAll(!all)} aria-expanded={all}>
                {all ? "less" : `+${outlets.length - CHIPS_SHOWN}`}
              </button>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

export function NewsWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const news = useStore((s) => s.news);
  const flash = useSettings((s) => s.flash);
  const clock = useClock();
  const [filter, setFilter] = useState<Filter>("linked");
  const [query, setQuery] = useState("");
  const now = useNow();
  const topic = instrument(symbol)?.topic;
  const linkedTags = topic ? TOPIC_TAGS[topic] : [];

  const shown = news.filter(
    (n) =>
      (filter === "all" ? true : filter === "linked" ? !topic || linkedTags.length === 0 || n.tags.some((t) => linkedTags.includes(t)) : n.tags.includes(filter)) &&
      matchesQuery(n, query),
  );

  // archive paging: older stories from the API (Postgres), for the current filter
  const wantTags = filter === "all" ? [] : filter === "linked" ? linkedTags : [filter];
  const [older, setOlder] = useState<NewsItem[]>([]);
  const [paging, setPaging] = useState<"idle" | "loading" | "end" | "error">("idle");
  const tagKey = wantTags.join(",");
  useEffect(() => {
    setOlder([]);
    setPaging("idle");
  }, [tagKey, query]);
  const liveIds = new Set(shown.map((n) => n.id));
  const list = [...shown, ...older.filter((n) => !liveIds.has(n.id))];
  const loadOlder = async () => {
    setPaging("loading");
    const before = list.length ? list[list.length - 1].publishedAt : Date.now();
    try {
      const res = await fetch(`${apiUrl()}/news?tags=${encodeURIComponent(tagKey)}&before=${before}&limit=100&q=${encodeURIComponent(query.trim())}`);
      if (!res.ok) throw new Error(String(res.status));
      const page: NewsItem[] = await res.json();
      setOlder((o) => [...o, ...page]);
      setPaging(page.length < 100 ? "end" : "idle");
    } catch {
      setPaging("error");
    }
  };

  return (
    <div className="news">
      <div className="toolbar no-drag">
        {FILTERS.map(([f, label]) => (
          <Button key={f} variant={f === filter ? "default" : "ghost"} size="sm" onClick={() => setFilter(f)}>
            {f === "linked" && topic ? `${label}: ${topic === "crude" ? "Crude + Oil" : "Nat Gas"}` : label}
          </Button>
        ))}
        <Input className="news-search" type="search" placeholder="Search" aria-label="Search headlines" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="news-count muted">{list.length}</span>
      </div>
      <div className="news-list" tabIndex={0} role="region" aria-label="Headlines">
        {list.length === 0 && paging !== "loading" ? (
          <p className="empty muted">{news.length ? "No headlines for this filter yet." : "Loading headlines…"}</p>
        ) : (
          list.map((n) => <Row key={n.id} n={n} now={now} flash={flash} stampOf={clock.stamp} />)
        )}
        <div className="news-more">
          {paging === "end" ? (
            <span className="muted">No older stories in the archive</span>
          ) : (
            <Button size="sm" disabled={paging === "loading"} onClick={loadOlder}>
              {paging === "loading" ? "Loading…" : paging === "error" ? "Archive unavailable, retry" : "Load older"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
