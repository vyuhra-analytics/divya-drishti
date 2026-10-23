# Calendar sources tracker

Started 2026-10-23. Goal: more than one free source behind the calendar, each source's figures kept side by side (the observation log already stores a source per figure), a typed-in forecast, and a visible flag when sources disagree.

Findings that shaped it (2026-10-23): no reliable free provider has a consensus forecast. Forex Factory (unofficial, in use) is the only free one. Finance Calendar (keyless, official publishers) and Yahoo's calendar (keyless, unofficial) give schedule, previous and actuals, and their consensus fields were empty on every event tested. Trading Economics and Investing.com are not scraped (Investing blocks automated clients, Trading Economics sells the data through a paid API). EODHD, FMP, Finnhub and FXStreet need keys or plans.

Status key: done, active, next, later, blocked.

| # | Item | Status | Output |
|---|---|---|---|
| 1 | Source adapter contract and matching (`SourceRow`, aliases per series, merge into planned events, never create events from a secondary source) | **done** | shared `calendarSources.ts` |
| 2 | Finance Calendar adapter (keyless, attribution link) | **done** | parser, fixture, canary |
| 3 | Yahoo calendar adapter (cookie and crumb handshake, own code) | **done** | parser, fixture, canary |
| 4 | Recorder: fetch the extra sources, merge their figures and release times as observations | **done** | `CalendarService` |
| 5 | Typed-in forecast: `POST /calendar/stored/:id/observations`, form in the Recorded tab, typed-in wins over feeds | **done** | API, panel, EIA Report analysis |
| 6 | Sources disagree flag (two sources, two actuals; two release times) | **done** | `StoredEvents.tsx` |
| 7 | Tests, mutation checks, smoke, source registry and attribution, CLAUDE.md | **done** | |

## Log

- 2026-10-23: items 5 to 7 done. Typed-in forecast (`parseTypedFigure`, route, form in the Recorded tab, `believed()`, the EIA report analysis reads typed-in first), sources-differ flag (`disagreements`), attribution link for Finance Calendar, smoke refusals, component and unit tests, mutation checks (six, all caught), CLAUDE.md. Left for the owner: a source with a consensus (a paid Trading Economics or EODHD plan, or a free FMP key to test) would be one more adapter and one alias; the smoke option-feed check fails whenever a browser is watching option contracts.
- 2026-10-23: items 1 to 4 done. Shared `calendarSources.ts`: `SourceRow`, aliases on `SERIES` (`financecalendar`: `us-eia-petroleum`, `us-eia-natural-gas`; `yahoo`: `EIA-Nat Gas Chg…`; add one regex to a series to match another event), `matchSeries`, `mergeSourceRows` (figures and release times under the source name; a row with no stored release is dropped, so a secondary source never creates an event), `parseFinanceCalendar`, `parseYahooCalendar`, `yahooCalendar()` (cookie + crumb handshake in our own code, crumb renewed once on 401/403; `yahoo-finance2` has no calendar module), recorded fixtures and canaries for both (`finance-calendar`, `yahoo-calendar`). `CalendarService.mergeSources`: asked every 15 min (every minute while a release is pending), 5-minute back-off, failures isolated, merged into the STORED events of the last 4 days and next 15. Live: the 16 Oct gas week now holds actuals from EIA and Yahoo and release times from Finance Calendar and Yahoo. Yahoo has no crude inventories row in the window checked, so WPSR gets only Finance Calendar release times.
- 2026-10-23: tracker created.
