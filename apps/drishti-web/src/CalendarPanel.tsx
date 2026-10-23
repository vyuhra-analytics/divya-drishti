import { useEffect, useRef, useState } from "react";
import { releasePending, todayEvents, type CalEvent, type CalKind, type TodayFocus } from "@drishti/shared";
import { useAlerts } from "./alertsStore";
import { apiUrl, useClock, useSettings } from "./settings";
import { useNow } from "./market";
import { StoredEvents } from "./StoredEvents";
import type { EiaScheduleException } from "@drishti/shared";
import type { Widget } from "./workspace";

type Tab = CalKind | "today" | "recorded";
const TABS: [Tab, string][] = [
  ["today", "Today"],
  ["energy", "Energy"],
  ["macro", "Macro"],
  ["holiday", "Holidays"],
  ["recorded", "Recorded"],
];
const REFRESH_MS = 15 * 60_000;
const REFRESH_PENDING_MS = 30_000; // a release is due or just out: look for its number every 30 s (the API itself re-reads the source every minute)
const SOON_MS = 60 * 60_000; // the next release within the hour gets the highlighted time

/** "-8.6M" / "83B" / "0.5%" → the number, for comparing actual with forecast. */
const numberOf = (v?: string) => {
  const n = Number((v ?? "").replace(/[^0-9.+-]/g, ""));
  return v !== undefined && Number.isFinite(n) && /\d/.test(v) ? n : undefined;
};

/** The figure the actual is judged against: the forecast, else the previous release. */
const baseline = (e: CalEvent) => numberOf(e.forecast) ?? numberOf(e.previous);

/** up or down colour class for an actual above or below its baseline (follows the Settings up/down colours); none when equal or unknown. */
function actualClass(e: CalEvent) {
  const a = numberOf(e.actual);
  const b = baseline(e);
  return a === undefined || b === undefined || a === b ? "" : a > b ? "up" : "down";
}

function actualTitle(e: CalEvent, time: (t: number) => string, now: number) {
  if (e.actual !== undefined) {
    const vs = numberOf(e.forecast) !== undefined ? "forecast" : "previous";
    const c = actualClass(e);
    return `Released${c ? `, ${c === "up" ? "above" : "below"} ${vs}` : ""}${e.src?.actual ? ` · source: ${e.src.actual}` : ""}`;
  }
  return e.at < now ? `Released ${time(e.at)}; waiting for the official figure` : "Not released yet";
}

/** Day header like "Thursday October 22 2026", in the app's number/date locale and the viewer's own zone. */
const dayLabel = (t: number, locale: string) => new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(t).replace(/,/g, "");

/** "in 3h 20m" / "2d" / "12m ago" */
function until(at: number, now: number) {
  const mins = Math.round((at - now) / 60_000);
  const abs = Math.abs(mins);
  const text = abs < 60 ? `${abs}m` : abs < 2880 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${Math.round(abs / 1440)}d`;
  return mins >= 0 ? `in ${text}` : `${text} ago`;
}

/** Calendar in four tabs: energy releases, macro and central bank events, MCX holidays, and what the recorder has stored. */
export function CalendarWidget(_: { widget: Widget }) {
  const [tab, setTab] = useState<Tab>("today");
  const [big, setBig] = useState<Record<string, boolean>>({ today: true }); // High + Med is on for Today, off for the browsing tabs
  const [focus, setFocus] = useState<TodayFocus>(() => {
    try {
      const f = localStorage.getItem("drishti-calendar-focus");
      return f === "gas" || f === "all" ? f : "crude";
    } catch {
      return "crude";
    }
  });
  const bigOnly = big[tab] ?? false;
  const pickFocus = (f: TodayFocus) => {
    setFocus(f);
    try {
      localStorage.setItem("drishti-calendar-focus", f);
    } catch {
      /* the choice just is not remembered */
    }
  };
  return (
    <div className="calendar">
      <div className="toolbar no-drag">
        {TABS.map(([k, label]) => (
          <button key={k} className={k === tab ? "tf active" : "tf"} onClick={() => setTab(k)} title={k === "recorded" ? "Releases saved by the recorder, with every forecast and actual as it was seen" : undefined}>
            {label}
          </button>
        ))}
        {tab !== "recorded" && tab !== "holiday" && (
          <button className={bigOnly ? "tf active" : "tf"} aria-pressed={bigOnly} onClick={() => setBig({ ...big, [tab]: !bigOnly })} title="Hide low-impact events">
            High + Med
          </button>
        )}
        {tab === "today" && (
          <span className="cal-focus" role="group" aria-label="What to show Today">
            {([["crude", "Crude"], ["gas", "Gas"], ["all", "All"]] as const).map(([f, label]) => (
              <button key={f} className={f === focus ? "tf active" : "tf"} onClick={() => pickFocus(f)} title={f === "all" ? "Every event" : `Events that move ${label.toLowerCase()}, the rupee and MCX itself`}>
                {label}
              </button>
            ))}
          </span>
        )}
      </div>
      {tab === "energy" && <EiaDelays />}
      {tab === "recorded" ? <StoredEvents /> : <LiveCalendar kind={tab} bigOnly={bigOnly} focus={focus} />}
    </div>
  );
}

/** EIA's official holiday delays still ahead, from its own schedule pages: "Thu 12 Nov 12:00 pm Veterans Day (petroleum)". */
function EiaDelays() {
  const [list, setList] = useState<EiaScheduleException[]>([]);
  const clock = useClock();
  const locale = useSettings((s) => s.locale);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${apiUrl()}/calendar/eia-schedule`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setList)
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  if (list.length === 0) return null;
  const day = (t: number) => new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" }).format(t);
  return (
    <p className="muted cal-delays" title="From EIA's official release schedule pages">
      <b>EIA delays ahead:</b>{" "}
      {list.slice(0, 3).map((x, i) => (
        <span key={`${x.report}${x.at}`}>
          {i > 0 && " · "}
          {day(x.at)} {clock.time(x.at)} {x.report === "WPSR" ? "crude" : "gas"} ({x.holiday})
        </span>
      ))}
    </p>
  );
}

function LiveCalendar({ kind, bigOnly, focus }: { kind: CalKind | "today"; bigOnly: boolean; focus: TodayFocus }) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);
  const clock = useClock();
  const locale = useSettings((s) => s.locale);
  const alerts = useAlerts((s) => s.alerts);
  const { add: addAlert, remove: removeAlert } = useAlerts.getState();

  const pending = events ? releasePending(events, now) : false;
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
    const id = setInterval(load, pending ? REFRESH_PENDING_MS : REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [pending]);

  // an actual that was not there on the last look is a fresh release: highlight it for a while
  const seenActual = useRef(new Map<string, string | undefined>());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!events) return;
    const arrived: string[] = [];
    for (const e of events) {
      if (seenActual.current.has(e.id) && seenActual.current.get(e.id) === undefined && e.actual !== undefined) arrived.push(e.id);
      seenActual.current.set(e.id, e.actual);
    }
    if (arrived.length) {
      setFresh((f) => new Set([...f, ...arrived]));
      const t = setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !arrived.includes(id)))), 15_000);
      return () => clearTimeout(t);
    }
  }, [events]);

  if (!events) return <p className="empty muted">{error ? `Calendar unavailable: ${error}` : "Loading calendar…"}</p>;

  const shown = kind === "today" ? todayEvents(events, now, focus, bigOnly) : events.filter((e) => e.kind === kind && (!bigOnly || e.impact !== "low"));
  const next = shown.find((e) => e.kind !== "holiday" && e.at >= now)?.id;
  const days: [string, CalEvent[]][] = [];
  for (const e of shown) {
    const day = dayLabel(e.at, locale);
    const last = days[days.length - 1];
    if (last?.[0] === day) last[1].push(e);
    else days.push([day, [e]]);
  }
  const watching = (e: CalEvent) => alerts.find((a) => a.kind === "release" && a.text === e.title);
  const toggleBell = (e: CalEvent) => {
    const a = watching(e);
    if (a) removeAlert(a.id);
    else addAlert({ kind: "release", text: e.title, minutes: 15 });
  };

  return (
    <>
      {error && <p className="down" title={error}>stale: {error}</p>}
      <div className="calendar-list" tabIndex={0} role="region" aria-label="Calendar events">
        {days.length === 0 && <p className="empty muted">Nothing scheduled.</p>}
        {days.map(([day, list]) => (
          <section key={day}>
            <div className="cal-day">
              <h2>{day}</h2>
              <span>Actual</span>
              <span>Previous</span>
              <span>Forecast</span>
            </div>
            {list.map((e) => {
              const soon = e.id === next && e.at - now < SOON_MS;
              const holiday = e.kind === "holiday";
              return (
                <div key={e.id} className={`cal-row${e.at < now ? " past" : ""}${e.id === next ? " next" : ""}`}>
                  <span className={`cal-time${soon ? " soon" : ""}`}>{holiday ? "" : clock.time(e.at)}</span>
                  <span className="cal-country" title={e.country ? undefined : "Global"}>
                    {e.country || ""}
                  </span>
                  <span className="cal-body">
                    <span className="cal-title">
                      <i className={`cal-dot ${e.impact}`} title={`${e.impact} impact`} />
                      {e.title}
                      {e.period && <small>{e.period}</small>}
                      {e.delay && <small className="cal-delayed" title={`EIA moved this release for ${e.delay.holiday}; normally ${clock.time(e.delay.normalAt)} on ${dayLabel(e.delay.normalAt, locale)}`}>DELAYED</small>}
                    </span>
                    <span className="muted cal-detail">
                      {e.detail}
                      {!holiday && ` · ${until(e.at, now)}`}
                    </span>
                  </span>
                  {!holiday && (
                    <>
                      <span className={`cal-actual ${actualClass(e)}${fresh.has(e.id) ? " fresh" : ""}`} title={actualTitle(e, clock.time, now)}>
                        {e.actual ?? (e.at < now ? "…" : "")}
                      </span>
                      <span className="cal-prev" title={e.src?.previous ?? e.src?.forecast ? `Previous release · source: ${e.src?.previous ?? e.src?.forecast}` : "Previous release"}>{e.previous ?? ""}</span>
                      <span className="cal-fc" title={e.src?.forecast ? `Consensus forecast · source: ${e.src.forecast}` : "Consensus forecast"}>{e.forecast ?? ""}</span>
                      <button
                        className={`cal-bell${watching(e) ? " on" : ""}`}
                        aria-pressed={!!watching(e)}
                        aria-label={`${watching(e) ? "Stop watching" : "Alert me 15 minutes before"} ${e.title}`}
                        title={watching(e) ? "Alert set: 15 min before every release. Click to remove" : "Alert me 15 minutes before this release"}
                        onClick={() => toggleBell(e)}
                      >
                        🔔
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </>
  );
}
