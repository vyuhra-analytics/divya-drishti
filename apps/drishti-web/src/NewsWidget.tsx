import { useEffect, useState } from "react";
import { instrument, isSafeUrl, type NewsItem, type NewsTag } from "@drishti/shared";
import { useStore } from "./store";
import { useSettings } from "./settings";
import { useWidgetSymbol, type Widget } from "./workspace";

type Filter = "linked" | "all" | NewsTag;
const FILTERS: [Filter, string][] = [
  ["linked", "Linked"],
  ["all", "All"],
  ["crude", "Crude / Oil"],
  ["natgas", "Nat Gas"],
  ["india", "India"],
];
const TAG_LABEL: Record<NewsTag, string> = { crude: "OIL", natgas: "NAT GAS", india: "INDIA" };
const NEW_MS = 2 * 60_000;

const ago = (t: number, now: number) => {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

const stamps = new Map<string, Intl.DateTimeFormat>();
/** Exact publish time in the viewer's time zone: "20 Oct 2026, 22:42 IST" (number style follows Settings). */
export function newsStamp(t: number, locale: string, timeZone?: string) {
  const key = `${locale}|${timeZone ?? ""}`;
  let f = stamps.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
      timeZone,
    });
    stamps.set(key, f);
  }
  return f.format(t);
}

/** Re-render every 30 s so "3m ago" and NEW markers stay honest without new items arriving. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Row({ n, now, flash, locale }: { n: NewsItem; now: number; flash: boolean; locale: string }) {
  const stamp = newsStamp(n.publishedAt, locale);
  const fresh = now - n.publishedAt < NEW_MS;
  return (
    <a
      className={`news-row${fresh && flash ? " news-fresh" : ""}`}
      // parseRss already drops non-http(s) links; checked again because this is where a click happens
      href={isSafeUrl(n.url) ? n.url : undefined}
      target="_blank"
      rel="noopener noreferrer"
      title={`${n.title}
${n.source} · ${stamp}`}
    >
      <span className="news-time">{ago(n.publishedAt, now)}</span>
      <span className="news-body">
        <span className="news-title">
          {fresh && <span className="news-new">NEW</span>}
          {n.title}
        </span>
        <span className="news-meta">
          <span>{n.source}</span>
          <time dateTime={new Date(n.publishedAt).toISOString()}>{stamp}</time>
          {n.tags.map((t) => (
            <span key={t} className={`news-tag tag-${t}`}>
              {TAG_LABEL[t]}
            </span>
          ))}
        </span>
      </span>
    </a>
  );
}

export function NewsWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const news = useStore((s) => s.news);
  const flash = useSettings((s) => s.flash);
  const locale = useSettings((s) => s.locale);
  const [filter, setFilter] = useState<Filter>("linked");
  const now = useNow();
  const topic = instrument(symbol)?.topic;

  const shown = news.filter((n) =>
    filter === "all" ? true : filter === "linked" ? !topic || n.tags.includes(topic) : n.tags.includes(filter),
  );

  return (
    <div className="news">
      <div className="toolbar no-drag">
        {FILTERS.map(([f, label]) => (
          <button key={f} className={f === filter ? "tf active" : "tf"} onClick={() => setFilter(f)}>
            {f === "linked" && topic ? `${label}: ${topic === "crude" ? "Crude / Oil" : "Nat Gas"}` : label}
          </button>
        ))}
        <span className="news-count muted">{shown.length}</span>
      </div>
      <div className="news-list">
        {shown.length === 0 ? (
          <p className="empty muted">{news.length ? "No headlines for this filter yet." : "Loading headlines…"}</p>
        ) : (
          shown.map((n) => <Row key={n.id} n={n} now={now} flash={flash} locale={locale} />)
        )}
      </div>
    </div>
  );
}
