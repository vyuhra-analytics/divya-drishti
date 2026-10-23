# Crude desk tracker

Started 2026-10-23. Owner's point: MCX crude is driven by NYMEX CL, USD/INR and the news about CL, so the evening screen should show those drivers, and the Calendar should answer "what is coming that moves crude or the rupee" on an ordinary evening, not only on report days.

Checked live before building (2026-10-23): CL 100.29 x USD/INR 94.87 = 9,514 against MCX crude 9,549 (+0.36%); the MCX Nov contract (expires 19 Nov) lines up with the Dec CL that CL=F tracks (expires 20 Nov). **The free CL feed is 10 minutes delayed** (Yahoo, TradingView) and Upstox has no NYMEX, so CL and USD/INR are context for the live MCX price, not a lead signal. The same relation holds for gas (NG x USD/INR = 258.7 against MCX 259.7).

Status key: done, active, next, later, blocked.

| # | Item | Status | Output |
|---|---|---|---|
| 1 | Calendar relevance tags on every event (crude, gas, usdinr, mcx) | **done** | `CalEvent.relevance` |
| 2 | Today tab: next 24 h plus the last 2 h, all kinds, filtered by what it moves (Crude / Gas / All), default tab | **done** | shared `todayEvents`, `CalendarPanel.tsx` |
| 3 | Drivers maths: fair value, premium, split of the day move (CL, rupee, premium), premium history from the 5-minute bars | later | shared `drivers.ts` |
| 4 | Drivers panel (`DRV`): the three legs with the 10-minute delay shown, fair value, premium against its range, the split | later | `DriversPanel.tsx` |
| 5 | Evening desk becomes the crude-day screen: chart, Drivers, quote, Today calendar, option chain | later | `presets.ts` |
| 6 | Tests, mutation checks, e2e panel check, CLAUDE.md | later | |

## Log

- 2026-10-23: items 1 and 2 done. `CalEvent.relevance` from `decorateEvents` (series tags, else by country: US moves crude and the rupee, India the rupee and MCX), shared `todayEvents` (last 2 h to next 24 h, holidays by day, Crude / Gas / All, High + Med) and `TODAY_FOCUS`; the Calendar opens on **Today** (High + Med on, focus remembered in localStorage); the other tabs are unchanged. Three mutation checks caught.
- 2026-10-23: tracker created.
