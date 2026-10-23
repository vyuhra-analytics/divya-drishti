# EIA report analysis tracker

Started 2026-10-23. Goal: on report day the trader gets the whole official EIA report (every table), the moment it is released, with the comparisons a trader reads (drivers, regions, history), from the official files only. No scraping browser: EIA publishes CSV files.

Status key: done, active, next, later, blocked. Update this file at the end of every item.

## Sources (checked 2026-10-23)

- WPSR: nine files `https://ir.eia.gov/wpsr/table1.csv` to `table9.csv` (follow redirects). Each carries this week, last week, the difference, the year ago and (tables 1 to 3, 7, 8) a 4-week average.
- WNGSR: `https://ir.eia.gov/ngs/wngsr.csv`: stocks by region, last week, net change, implied flow, year ago and the **5-year average** with percent changes, and a header line giving the exact release time.
- 5-year averages for crude and products: the EIA v2 series already read by the EIA panel (needs `EIA_API_KEY`).

## Items

| # | Item | Status | Output |
|---|---|---|---|
| 1.1 | Parse tables 1 to 9 and the gas file into rows (header-driven columns, groups, units, year ago, 4-week and 5-year averages) | **done** | shared `eiaReport.ts`, tests on recorded fixtures |
| 1.2 | Store every row (migration 015: group, table, year ago, averages, order) | **done** | `eia_series`, `eia_report_values` |
| 1.3 | Record fixtures for the nine tables and the gas file | **done** | `packages/shared/fixtures`, contract test |
| 1.4 | Backfill the week of 2026-10-16 (both reports) from the files still on the server | **done** | rows in the database |
| 2.1 | Release watcher: poll around each release, detect the new week, parse, store, record the delay | **done** | API service, `GET /eia-report/latest` |
| 2.2 | Delay log: seconds from the official release time to our first stored row, kept per release | **done** | table or kv, shown in the panel |
| 3.1 | Crude analysis rules: headline vs forecast and threshold, drivers (runs, imports, exports, demand, production), regions (PADD 3, Cushing), history | **done** | shared `eiaAnalysis.ts` |
| 3.2 | Products analysis: gasoline, distillate, jet, propane, days of supply | **done** | same |
| 3.3 | Consistency checks: does the headline agree with the drivers | **done** | same |
| 4.1 | EIA Report panel (grouped tables, facts, analysis lines, surprise block) | later | `EiaReportPanel.tsx`, code `ER` |
| 4.2 | Put it on the Report prep desk and the report-day layout | later | `presets.ts` |
| 5.1 | Gas analysis: regions vs 5-year and year ago, implied flow, surprise in Bcf vs 5.0 | **done** | shared `eiaAnalysis.ts` |
| 6.1 | Smoke checks, e2e panel check, mutation checks, CLAUDE.md and docs | later | tests, docs |

## Log

- 2026-10-23: items 3.1 to 3.3 and 5.1 done. Shared `eiaAnalysis.ts`: `analyzeWpsr` (headline and surprise rule, crude stocks with SPR/Cushing/regions, drivers ranked by their effect on stocks, refining, products with days of supply against a year ago, consistency checks) and `analyzeWngsr` (build vs 5-year and year ago, regional movers, salt caverns). Every line cites its series ids; thresholds live in `RULES`; mutation-checked (side rule, threshold boundary, export sign, adjustment flag). `GET /eia-report` now returns the analysis, with the forecast typed in (`forecast=`) or the one recorded for the release.
- 2026-10-23: items 1.1 to 2.2 done. Parser (`eiaReport.ts`, nine tables, 884 rows for the 16 Oct week, gas with 5-year average), fixture `eia-wpsr-tables`, migration 015, `PgEiaReportStore`, `EiaReportWatcher` (polls table 1 every 3 s from 90 s before the release, fetches the rest on a new week, never mixes weeks, stores once), routes `GET /eia-report` and `/eia-report/arrivals`. The 16 Oct week of both reports was backfilled from the files still on the server (marked backfilled: the delay is not a watcher measurement). First real delay figure comes at the 28 Oct release.
- 2026-10-23: tracker created. Findings: the database holds only the gas release of 2026-10-16 (8 rows); no petroleum rows yet (the recorder started after the 21 Oct release).
