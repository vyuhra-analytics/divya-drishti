import { useEffect, useState } from "react";
import type { CalEvent, CalKind } from "@drishti/shared";
import { apiUrl, formatStamp, useClock, useSettings } from "./settings";
import { useNow } from "./market";
import type { Widget } from "./workspace";

type Filter = "all" | CalKind;
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["energy", "Energy"],
  ["macro", "Macro"],
  ["holiday", "Holidays"],
];
const REFRESH_MS = 15 * 60_000;

/** "in 3h 20m" / "2d" / "12m ago" */
function until(at: number, now: number) {
  const mins = Math.round((at - now) / 60_000);
  const abs = Math.abs(mins);
  const text = abs < 60 ? `${abs}m` : abs < 2880 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${Math.round(abs / 1440)}d`;
  return mins >= 0 ? `in ${text}` : `${text} ago`;
}

/** Energy calendar: US inventory/rig reports, OPEC, high-impact US macro and MCX holidays, grouped by local day. */
export function CalendarWidget(_: { widget: Widget }) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow(30_000);
  const clock = useClock();
  const locale = useSettings((s) => s.locale);
  const clockSetting = useSettings((s) => s.clock);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetch(`${apiUrl()}/calendar?days=14`, { signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setEvents(await res.json());
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, []);

  if (!events) return <p className="empty muted">{error ? `Calendar unavailable: ${error}` : "Loading calendar…"}</p>;

  const shown = events.filter((e) => filter === "all" || e.kind === filter);
  const next = shown.find((e) => e.at >= now)?.id;
  const days: [string, CalEvent[]][] = [];
  for (const e of shown) {
    const day = formatStamp(e.at, locale, clockSetting, "date");
    const last = days[days.length - 1];
    if (last?.[0] === day) last[1].push(e);
    else days.push([day, [e]]);
  }

  return (
    <div className="calendar">
      <div className="toolbar no-drag">
        {FILTERS.map(([f, label]) => (
          <button key={f} className={f === filter ? "tf active" : "tf"} onClick={() => setFilter(f)}>
            {label}
          </button>
        ))}
        {error && <span className="down" title={error}>stale</span>}
      </div>
      <div className="calendar-list">
        {days.length === 0 && <p className="empty muted">Nothing scheduled.</p>}
        {days.map(([day, list]) => (
          <section key={day}>
            <h4>{day}</h4>
            {list.map((e) => (
              <div key={e.id} className={`cal-row${e.at < now ? " past" : ""}${e.id === next ? " next" : ""}`}>
                <span className="cal-time">{e.kind === "holiday" ? "all day" : clock.time(e.at)}</span>
                <span className={`cal-dot ${e.impact}`} title={`${e.impact} impact`} />
                <span className="cal-body">
                  <span className="cal-title">{e.title}</span>
                  <span className="muted cal-detail">
                    {e.detail}
                    {(e.forecast || e.previous) && ` · forecast ${e.forecast ?? "—"} · previous ${e.previous ?? "—"}`}
                  </span>
                </span>
                {e.kind !== "holiday" && <span className="cal-until muted">{until(e.at, now)}</span>}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
