# Redesign tracker

The single source of truth for the redesign. The visual tracker shown in the conversation is rendered from this file and re-rendered after every change.
Started 2026-10-22. Rule: no code until step 3.

Status key: done, active, next, later, blocked.

## Steps

| # | Step | Status | Output |
|---|---|---|---|
| 1 | Define the user and the jobs | **done** | `USER_AND_JOBS.md`: day in the life, decisions, risk rules, strategy rules |
| 2 | Information architecture and design system on paper | **done** | desks, panel and command grammar, design spec, cut list, mock-ups |
| 3 | Prototype on a replayed real session | **active** | replay tool, clickable prototype |
| 4 | Build in thin slices with trader-terms acceptance | later | slices, each with a timed task |
| 5 | Verify to level 4, then a forward paper run | later | task timings, latency, data-truth audit, paper run |

## Step 1 items

| # | Item | Status | Answer |
|---|---|---|---|
| 1.1 | What is traded | **answered** | Buying options (CE/PE), one lot fixed: crude (standard) and NATGASMINI options; signals read on the future |
| 1.2 | Style, hold time, sessions | **answered** | Intraday; MCX evening 17:00 to 23:30 IST |
| 1.3 | Screens | **answered** | One large monitor |
| 1.4 | Tools used today | **answered** | TradingView (messy, constant zooming); Upstox (tidy, all the information needed) |
| 1.5 | Capital | **answered** | Rs 70,000 real; premium sets the capital per trade |
| 1.6 | Daily limits | **answered** | Rs 500 to 1,000 in loss or in profit |
| 1.7 | Strategy rules | **answered, details unclear** | USIB (non-report days) and EIA B1 breakout (Wed WPSR, Thu WNGSR); see USER_AND_JOBS.md |
| 1.8 | Clarifications on the strategies and option handling | **answered** | all rules answered; daily limit is a hard rupee stop on the open option (R levels only set targets); EIA range = last hour before the print; long above / short below VWAP |
| 1.9 | A real recent evening session, narrated | **answered** | in the trade: watches option premium and the future; exit by hand; one trade a day, then done for the day |

## Decisions log

| date | decision |
|---|---|
| 2026-10-22 | JODI removed (done, `d14e4b7`) |
| 2026-10-22 | Live TV kept |
| 2026-10-22 | Insider trades, energy heatmap, energy screener, ticker tape: cut or optional, decide in step 2 |
| 2026-10-22 | Simple chart and compact option chain: cut as duplicates, decide in step 2 |
| 2026-10-22 | Owner decision: the limit-equivalent line is the working stop (and the Rs 1,000 line the working target); R stop, TP1, TP2 shown as secondary. Finding: on crude the Rs 500 limit is about a 7-point future stop (spread included, delta 0.5); replay of the two EIA Wednesdays with an entry in the 30-minute window (7 and 14 Oct) hit it first on both, stop assumed first inside a candle; two trades, not a result |
| 2026-10-22 | Prototype task T1 (signal: price, nearest levels, Rs to stop): 12 s against a 3 s target; the stop was hard to find because it was only drawn after the buy. Fix: planned entry / stop / TP1 / TP2 shown at the signal, plus a level ladder (distance in points and option Rs) and a line saying the Rs 500 loss limit comes first. T2 and T3 timings not yet reported |
| 2026-10-22 | Prototype built (`prototype/eia-replay.html`, replay of 7 Oct): chart, report block, simulated chain, trade, alerts, timed-task stopwatch; first run: Rs 500 loss limit fired on a late entry although the day later moved 68 pts the trade's way |
| 2026-10-22 | Step 2 complete: dark theme everywhere, alert sounds accepted, no colour issues |
| 2026-10-22 | Design system spec drafted (`DESIGN_SYSTEM.md`): position colours (`--good`/`--bad`) separate from market direction (`--up`/`--down`), 28 px numbers, four alert classes with sounds; 3 questions open |
| 2026-10-22 | Research desk drafted (`RESEARCH_DESK.md`): five workspaces on F2 to F6, Esc toggles desks, alerts reach any desk; accepted: all five workspaces, review = numbers + note |
| 2026-10-22 | Settings accepted: tightening allowed any time, loosening waits for tomorrow |
| 2026-10-22 | Settings drafted (`SETTINGS.md`): loss limit Rs 500, profit limit Rs 1,000; rules locked 17:00 to 23:30 IST (loosening waits until tomorrow, tightening allowed: Claude refinement, to confirm) |
| 2026-10-22 | Chart rules drafted (`CHART_RULES.md`): auto-follow only, fixed 48-bar window, at most 8 app-drawn levels with rupee equivalents, no toolbar; all 5 questions answered |
| 2026-10-22 | Cut list first pass accepted (`CUT_LIST.md`): cut GS, OC, HM, SCR, INS, ticker tape; 9 panels to a Research desk; 6 kept and reshaped |
| 2026-10-22 | Expiry: crude nearest, gas next; crude premium fits the Rs 70,000 capital |
| 2026-10-22 | USIB (non-report-day) parked by the owner: needs more work before its screen or spec |
| 2026-10-22 | Step 2 started: first wireframe of the EIA report-day screen (`EIA_SCREENS.md`): six stages on one monitor |
| 2026-10-22 | EIA defaults set by Claude (changeable): skip a break against the surprise; no new entry after 30 minutes; forecast typed in or Forex Factory, never scraped; stop assumed first in a shared candle |
| 2026-10-22 | EIA rules: range = full last hour; entry on a 5-minute close beyond it at the next future open; window from the print to the time stop; surprise sets direction and a range break alone also trades; forecast from Trading Economics / Investing.com (connection open) |
| 2026-10-22 | Decision: EIA surprise thresholds are 3 million barrels (crude) and 5.0 Bcf (gas); focus on the EIA report-day strategy first |
| 2026-10-22 | Decision: the daily limit is a hard rupee stop on the open option; the R levels through delta only set targets |
| 2026-10-22 | Finding: R translated through delta still gives about Rs 3,000 per stop-out on crude, against a Rs 500 to 1,000 daily limit; which one rules is open |
| 2026-10-22 | Finding: with delta 0.5 to 0.6 one R on the future is 2.7 to 6.6 times the daily loss limit on the option, so the premium, not R, is the real risk rule (to confirm) |
| 2026-10-22 | Finding: the traded instrument is a bought option (one lot), signals on the future; the default chart resembles TradingView, which the owner dislikes |

## Carried items (from the assessment)

Verification debts: costs vs a real contract note; Telegram alert on the phone; briefing against the real model; insider panel live; tick-to-screen latency;
prices vs exchange settlement; a timed task test with the owner. Sentiment study: waiting for data (first-seen clock started 2026-10-22).
