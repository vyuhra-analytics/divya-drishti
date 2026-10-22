# Research desk layout (step 2, on paper, 2026-10-22)

The second desk. The **Evening desk** (`EIA_SCREENS.md`) is the trading screen; the **Research desk** is where the owner thinks: before the session, after it, on days off. It uses the panels the cut list sent there (`CUT_LIST.md`), plus the advanced chart (zoom welcome) and the detailed option chain.

## Rules

1. **One key switches desks** (`Esc` toggles Evening / Research). Switching never loses the evening state: the trade, the result gauge and the countdown keep running underneath.
2. **Alerts reach the owner on any desk.** A stop, TP, cap or time-stop alert shows as a banner and a sound over whatever is open, with a button back to the Evening desk.
3. The Research desk is **not locked** and may be rearranged (the grid, link groups and saved workspaces already work); the Evening desk is fixed.
4. Every workspace answers one question; if it does not, it does not exist.

## Workspaces (each fits one large monitor on the 12-column grid; none is wider than 12)

| Workspace | Question it answers | When | Panels (columns x rows) |
|---|---|---|---|
| **Pre-session** | What is the market doing before 17:00, and is today a report day? | afternoon, before the evening | Recap (4x4), Calendar (4x4), Futures curve (4x4); Advanced chart 5-min (8x6), News (4x6) |
| **Report prep** (Tue, Wed, Thu) | What will the surprise be, and where are the options priced? | the day of a WPSR or WNGSR, before the range hour | EIA stocks (6x5), Calendar (6x5), Detailed option chain (12x6), Advanced chart (6x5), COT (6x5) |
| **Review** | What happened on the day or the week, and did I follow the rules? | after the session | Paper trading journal (6x8), Advanced chart with replay (6x8), Costs (6x4), Data quality (6x4) |
| **Study** | Do the rules work, over what history? | weekends | Strategy tester (8x8), Advanced chart with replay (4x8), Costs (4x4), Positioning (4x4) |
| **Macro and TV** | The wider energy picture | optional | Chokepoints (6x5), Futures curve (6x5), Live TV (6x5), News (6x5) |

Five workspaces, switched with `F2` to `F6` (F1 stays the Evening desk). The existing preset mechanism (built-in presets plus up to 20 saved) carries this; the old presets (MCX crude, Natural gas, Options, Research, Live watch) are replaced by these.

## Reshapes needed for the Research desk to serve the redesign

- **Paper trading journal** (Review): records the owner's *actual* one trade a day in options (premium, rupee P&L, which exit ended it, which rule applied) and the review of the stop-first assumption; today it is a futures simulator. This is the owner's track record, the thing every later claim about the strategies depends on.
- **Strategy tester** (Study): rebuilt around the owner's own rules (the rupee-capped scalp, the EIA first-break entry with the cut-off, the 5-minute close beyond the last-hour range), not the three generic strategies it has now. Its small history (22 evenings of stored 5-minute bars) must be said on screen.
- **Replay** exists on the advanced chart (stored 1m bars, play / step); Review and Study use it to rehearse a day.
- **Panels that stay as they are**: Recap, Calendar, Curve, COT, Chokepoints, EIA stocks, News, Live TV, Costs, Data quality.

## Not designed yet

Phone width; what the Pre-session Recap should say for an options trader (it is written for futures today); the review checklist; weekly summary numbers.

## Settled (2026-10-22)

1. **All five workspaces stay.**
2. Pre-session: the owner's answer is "check", which repeats the earlier walk-through without saying what is looked at. **Kept as the default list above (Recap, Calendar, Curve, Advanced chart, News)**; to refine when the owner names what they open (candidates: NYMEX price, USD/INR, the calendar for the day, headlines, the chain).
3. **Review shows numbers and a note** (entry, exit, rupee P&L, which exit ended the day, plus a free-text note). No screenshot.

## Built (2026-10-22)

The five workspaces and an interim Evening desk exist as the built-in presets F1 to F6 (`apps/drishti-web/src/presets.ts`), laid out for a 1080p monitor in the default density. Not built: the `Esc` toggle between the Evening and Research desks (the Evening screen is still the interim preset) and alerts reaching every desk as banners (toasts already do). The old crude, gas, options, research and live-watch presets were replaced.
