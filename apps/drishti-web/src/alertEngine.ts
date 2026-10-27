import { check, type Alert, type AlertWorld, type CalEvent, type NewsItem } from "@drishti/shared";
import { useAlerts } from "./alertsStore";
import { apiUrl, useSettings } from "./settings";
import { useStore } from "./store";

const RELEASE_CHECK_MS = 30_000;
const EVENTS_TTL_MS = 10 * 60_000;
const FRESH_NEWS_MS = 15 * 60_000;

/** Short two-tone beep (Web Audio: no asset to ship). Silently does nothing when the browser blocks audio. */
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    osc.onended = () => ctx.close();
  } catch {
    /* audio unavailable */
  }
}

export function notify(message: string) {
  const { alertSound } = useSettings.getState();
  if (alertSound) beep();
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Divya Drishti alert", { body: message });
  } catch {
    /* some webviews throw on the constructor */
  }
}

let events: { at: number; list: CalEvent[] } = { at: 0, list: [] };
async function loadEvents(): Promise<CalEvent[]> {
  if (Date.now() - events.at < EVENTS_TTL_MS) return events.list;
  try {
    const res = await fetch(`${apiUrl()}/calendar?days=3`);
    if (res.ok) events = { at: Date.now(), list: await res.json() };
  } catch {
    /* calendar optional: release alerts just wait */
  }
  return events.list;
}

// the last value seen per alert lives here, not in the store: it changes every tick and would rewrite localStorage each time
const lasts = new Map<string, number | undefined>();

/** Run every alert against the current world; fired ones become a toast, a notification and a history row. */
function run(world: Omit<AlertWorld, "now" | "quotes">, kinds: Alert["kind"][]) {
  const { alerts, update, push } = useAlerts.getState();
  const full: AlertWorld = { ...world, quotes: useStore.getState().quotes, now: Date.now() };
  for (const a of alerts) {
    if (!kinds.includes(a.kind)) continue;
    const { next, message } = check({ ...a, last: lasts.get(a.id) }, full);
    lasts.set(a.id, next.last);
    const { last: _l, ...saved } = next;
    if (saved.armed !== a.armed || saved.firedAt !== a.firedAt || saved.lastEvent !== a.lastEvent) update({ ...saved, last: undefined });
    if (message) {
      push(a.id, message);
      notify(message);
    }
  }
}

/** Watches quotes, news and the calendar for as long as the app is open. Returns a stop function. */
export function startAlertEngine() {
  let seenNews = new Set(useStore.getState().news.map((n) => n.id));
  const unsub = useStore.subscribe((s, p) => {
    if (s.quotes !== p.quotes) run({ freshNews: [], events: [] }, ["price", "change"]);
    if (s.news !== p.news) {
      // the stream sends the whole backlog on (re)connect: only headlines published in the last 15 min can be news worth an alert
      const recent = Date.now() - FRESH_NEWS_MS;
      const fresh: NewsItem[] = s.news.filter((n) => !seenNews.has(n.id) && n.publishedAt > recent);
      seenNews = new Set(s.news.map((n) => n.id));
      if (fresh.length) run({ freshNews: fresh, events: [] }, ["news"]);
    }
  });
  const tick = async () => {
    if (useAlerts.getState().alerts.some((a) => a.kind === "release")) run({ freshNews: [], events: await loadEvents() }, ["release"]);
  };
  const id = setInterval(tick, RELEASE_CHECK_MS);
  return () => {
    unsub();
    clearInterval(id);
  };
}
