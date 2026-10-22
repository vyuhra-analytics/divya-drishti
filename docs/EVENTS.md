# Economic calendar: how events are stored and how to add one

## The pieces

| Piece | Where | What it holds |
|---|---|---|
| Dictionary | `packages/shared/src/eventSeries.ts` `SERIES` | One entry per KIND of event: title, category, country, importance, relevance tags, source, schedule rule |
| `event_series` | Postgres | The dictionary, copied in by the recorder (code is the source of truth) |
| `economic_events` | Postgres | One row per occurrence. Unique on `(series_code, key)`; `scheduled_at` can move, `original_scheduled_at` never does |
| `event_observations` | Postgres | Append-only log: forecast / previous / actual / revised, each with value as published, number, unit, source, `observed_at`, `backfilled` |
| `eia_series`, `eia_report_values` | Postgres | Every row of the WPSR stocks table and the WNGSR regional table, one row per series per release, FK to the event |

Nothing derived is stored. Surprise (actual minus forecast), threshold hits and price reaction are computed when asked.

## Natural key

- API, WPSR, WNGSR: the Friday ending the week they cover (`2026-10-16`). A holiday-shifted release keeps its row and just gets a new `scheduled_at`.
- Baker Hughes: the New York release date.
- Everything else: the calendar date.

## Point-in-time queries

Pick the latest observation of a kind with `observed_at <= T` and you know what was believed at T. A changed forecast is a new row, never an update. Rows recorded by the live recorder have a true `observed_at`. Anything loaded afterwards must set `backfilled = true`: its `observed_at` is the load time, and a study must not treat it as known earlier.

## The recorder

`CalendarService.record()` in `apps/drishti-core-api/src/calendar.service.ts`, started with the API.

- Every 5 minutes (every minute while a release is due or just out): builds the live calendar for the next 56 days, plans each event (`planEvent`), writes it (`recordPlanned`), then stores the EIA table of a release that is out and has none yet.
- Safe to repeat: events match on series and key, observations are unique on `(event, kind, value, source)`.
- `CALENDAR_RECORDER=off` disables it.
- It records what the free sources show. Forex Factory only lists the current week, so forecasts for later weeks appear as the weeks come.

Read it back: `GET /calendar/stored?from&to&series` (events with their observations in the order seen) and `GET /calendar/stored/:id/eia` (the full EIA table of one release).

## Adding an event kind

1. Add an entry to `SERIES`. That is the whole change for a scheduled series.
2. If its actual comes from a source we do not read yet, add a reader next to the EIA and FRED ones in `calendar.service.ts` (`withActuals`).
3. Add a test: `occurrences()` for the schedule, `planEvent()` for the key.

Worked examples (not added; add them when a source for the actual exists):

```ts
// RBI MPC meeting minutes: published on a calendar the RBI releases, so list the dates.
{
  code: "RBI_MPC_MINUTES", title: "RBI MPC meeting minutes", category: "central_bank", country: "IN",
  importance: "high", frequency: "irregular", detail: "Minutes of the Monetary Policy Committee meeting",
  relevance: ["usdinr", "mcx"], source: "Reserve Bank of India",
  schedule: { kind: "dates", at: [Date.UTC(2026, 11, 18, 11, 30)] }, // 17:00 IST
}

// India FX reserves (USD): a weekly statistical supplement, Friday 17:00 IST.
{
  code: "IN_FX_RESERVES", title: "India FX reserves (USD)", category: "data", country: "IN",
  importance: "medium", frequency: "weekly", detail: "RBI weekly statistical supplement",
  relevance: ["usdinr"], source: "Reserve Bank of India",
  schedule: { kind: "weekly", tz: "Asia/Kolkata", weekday: 5, hour: 17, minute: 0 },
}
```

Rows that a feed brings (Forex Factory) need no entry: the first sight creates a series `FF:<COUNTRY>:<TITLE>` and the same row always lands in it.

## Backfilled forecasts

Loading history is left to the owner. Insert into `event_observations` with `backfilled = true` and the true source. If the event does not exist yet, create it in `economic_events` with the series' natural key.
