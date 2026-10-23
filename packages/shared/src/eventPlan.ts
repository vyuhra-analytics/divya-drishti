// From the calendar's live events to rows for the stored economic calendar: which series each event belongs to, its natural key (so a repeat is the
// same row, not a new one), the figures to append to the observation log, and how an event that moved (a holiday-shifted release) finds its row.
// Pure and tested; the recorder (API) does the database work.
import type { CalEvent } from "./calendar";
import { autoSeries, parseValue, seriesByCode, seriesByLegacyKey, type EventCategory, type EventSeriesDef } from "./eventSeries";
import { tzOffsetSec } from "./index";

const NY = "America/New_York";
const DAY = 86_400_000;

export type ObservationKind = "forecast" | "previous" | "actual" | "revised" | "release_time";

export interface ObservationIn {
  kind: ObservationKind;
  /** as published ("-4.6M") */
  text: string;
  num?: number;
  unit?: string;
  /** who said it: "Forex Factory", "EIA weekly report (ir.eia.gov)", "FRED (St. Louis Fed)", "typed in" */
  source: string;
}

export interface PlannedEvent {
  series: EventSeriesDef;
  /** the natural key inside the series: the week-ending date for the weekly US reports, the calendar date otherwise */
  key: string;
  /** scheduled time, epoch ms */
  at: number;
  title: string;
  /** the period the figures cover, when the series has one (the week-ending date) */
  period?: string;
  observations: ObservationIn[];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Friday that ends the week a Tuesday-to-Thursday US weekly report covers, as YYYY-MM-DD (the last Friday before the release day in New York). */
export function weekEndingIso(releaseAt: number): string {
  const local = new Date(releaseAt + tzOffsetSec(NY, releaseAt) * 1000);
  const back = ((local.getUTCDay() - 5 + 7) % 7) || 7;
  return iso(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back));
}

const nyDay = (ms: number) => iso(ms + tzOffsetSec(NY, ms) * 1000);

const CENTRAL_BANK = /\b(fomc|federal funds rate|monetary policy|rate (?:decision|statement)|minutes|rbi|mpc|ecb|boe|boj|press conference)\b/i;

/** The category a feed row falls in: an energy item (OPEC), a central bank item, or plain macro. */
export const categoryOfFeedRow = (title: string, kind: CalEvent["kind"]): EventCategory => (kind === "energy" ? "energy" : CENTRAL_BANK.test(title) ? "central_bank" : "macro");

/** The natural key of a release of a series at a time: the week-ending Friday for the weekly US reports, the New York date for the rig count, else the date. */
export function naturalKey(series: EventSeriesDef, at: number): string {
  if (series.code === "RIGS") return nyDay(at);
  if (series.code === "API" || series.code === "WPSR" || series.code === "WNGSR") return weekEndingIso(at);
  return iso(at);
}

/** The stored-calendar identity of one live calendar event: its series (defined by us, or born from a feed row) and its natural key. */
export function planEvent(e: CalEvent): PlannedEvent | undefined {
  const legacy = /^(api|eia-oil|eia-gas|rigs|mcx)-/.exec(e.id);
  let series: EventSeriesDef | undefined;
  let key: string;
  let period: string | undefined;
  if (legacy) {
    series = seriesByLegacyKey(legacy[1]);
    if (!series) return undefined;
    if (series.code === "MCX_HOLIDAY") key = /^mcx-(\d{4}-\d{2}-\d{2})/.exec(e.id)?.[1] ?? iso(e.at);
    else if (series.code === "RIGS") key = nyDay(e.at);
    else key = period = weekEndingIso(e.at);
  } else if (/^ser:/.test(e.id)) {
    series = seriesByCode(/^ser:(.+)-\d+$/.exec(e.id)?.[1] ?? "");
    if (!series) return undefined;
    key = iso(e.at);
  } else {
    const ff = /^ff-([A-Za-z]+)-\d+-/.exec(e.id);
    if (!ff) return undefined;
    const title = e.title.replace(/ \((?:US|IN|EA|GB|JP|CN|CA|AU)\)$/, "");
    series = autoSeries(ff[1], title, e.impact, categoryOfFeedRow(title, e.kind));
    key = iso(e.at);
  }
  const observations: ObservationIn[] = [];
  const add = (kind: ObservationKind, text: string | undefined, source: string | undefined) => {
    if (text === undefined || text === "") return;
    observations.push({ kind, text, ...parseValue(text), source: source ?? "unknown" });
  };
  add("forecast", e.forecast, e.src?.forecast);
  add("previous", e.previous, e.src?.previous ?? e.src?.forecast); // from our own record when the feed had none, else the same feed as the forecast
  add("actual", e.actual, e.src?.actual);
  return { series, key, at: e.at, title: series.title, period, observations };
}

/** Every plannable event of a calendar list; events that belong to no series (an unknown id shape) are left out. */
export const planEvents = (events: CalEvent[]): PlannedEvent[] => events.flatMap((e) => planEvent(e) ?? []);

export interface StoredEventRef {
  id: number;
  seriesCode: string;
  key: string;
  /** epoch ms */
  scheduledAt: number;
  status: string;
}

/**
 * The stored row an incoming event updates: the same series and key; failing that, the nearest not-yet-released event of the same series within three
 * days (a release moved by a holiday keeps its row and gets its new time) and no row of another week.
 */
export function matchStored(stored: StoredEventRef[], p: Pick<PlannedEvent, "series" | "key" | "at">): StoredEventRef | undefined {
  const same = stored.filter((s) => s.seriesCode === p.series.code);
  const exact = same.find((s) => s.key === p.key);
  if (exact) return exact;
  const near = same.filter((s) => s.status !== "released" && Math.abs(s.scheduledAt - p.at) < 3 * DAY).sort((a, b) => Math.abs(a.scheduledAt - p.at) - Math.abs(b.scheduledAt - p.at));
  return near[0];
}

export const knownSeries = (code: string) => seriesByCode(code);

/** What the recorder needs from the database; the API implements it over Postgres, tests over a fake. */
export interface EventStore {
  upsertSeries(def: EventSeriesDef): Promise<void>;
  /** stored events whose scheduled time is inside [from, to) */
  stored(from: number, to: number): Promise<StoredEventRef[]>;
  insertEvent(p: PlannedEvent): Promise<number>;
  /** the release moved (a holiday); the original time stays */
  moveEvent(id: number, at: number): Promise<void>;
  /** appends the figures not already on record for this event; returns how many were new */
  addObservations(id: number, obs: ObservationIn[]): Promise<number>;
  markReleased(id: number, at: number): Promise<void>;
}

export interface RecordResult {
  created: number;
  moved: number;
  observations: number;
  released: number;
}

/**
 * Writes planned events to the store: a new event is inserted, a known one is matched by series and key (or moved when a release shifted), every
 * figure is appended to the log, and an event gets `released` the first time an actual shows up. Safe to run again and again with the same input.
 */
export async function recordPlanned(store: EventStore, planned: PlannedEvent[], from: number, to: number, now: number): Promise<RecordResult> {
  const out: RecordResult = { created: 0, moved: 0, observations: 0, released: 0 };
  const seen = new Set<string>();
  for (const p of planned) {
    if (!seen.has(p.series.code)) {
      seen.add(p.series.code);
      await store.upsertSeries(p.series);
    }
  }
  const stored = await store.stored(from - 3 * DAY, to + 3 * DAY);
  for (const p of planned) {
    const hit = matchStored(stored, p);
    let id: number;
    if (hit) {
      id = hit.id;
      if (hit.status !== "released" && hit.scheduledAt !== p.at) {
        await store.moveEvent(id, p.at);
        hit.scheduledAt = p.at;
        out.moved++;
      }
    } else {
      id = await store.insertEvent(p);
      stored.push({ id, seriesCode: p.series.code, key: p.key, scheduledAt: p.at, status: "scheduled" });
      out.created++;
    }
    out.observations += await store.addObservations(id, p.observations);
    const row = stored.find((s) => s.id === id)!;
    if (row.status !== "released" && p.observations.some((o) => o.kind === "actual")) {
      await store.markReleased(id, now);
      row.status = "released";
      out.released++;
    }
  }
  return out;
}
