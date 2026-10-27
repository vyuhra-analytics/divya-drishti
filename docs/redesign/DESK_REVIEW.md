# Evening (F1) and Report day (F7) desks: review (2026-10-27)

Checked against `USER_AND_JOBS.md` (the owner's jobs and decisions), `EIA_SCREENS.md`, `EIA_STRATEGY.md`, and the running app at 1920 x 1080 (panel sizes and scroll measured in the page). Ranked by how much it matters to the evening, each with what I would do. Findings marked **bug** go against a decision already recorded.

## What the desks are today

- **F1 Evening**: advanced chart 6 wide (17 rows), Drivers and Quote 3 wide each (8 rows), crude news 6 wide, the full option chain 12 wide (11 rows). An interim of existing panels.
- **F7 Report day**: the same chart 8 wide, and the Report day panel 4 wide (28 rows): stages prep to done, the checklist, the number and surprise, the range, the window, the strike, the trade, the review.

## Evening desk

1. **No strategy on it.** The owner's evening has two mechanical strategies; the Evening desk runs neither. The non-report-day strategy (USIB: the 18:00 to 19:00 IST range, a 5-minute close beyond it with volume at least 1.5x the previous ten candles and price on the right side of session VWAP, one trade a day, R = 1.5 x ATR(14), TP1 +1R then the stop to entry, trail, time stop) has no screen, no state and no levels. On every non-report day, which is most days, the desk is a general monitor. **Do: a USIB panel built the way Report day is** (waiting / signal / entered / TP1 / trailing / done, the range, volume against the ten-candle average, VWAP side, levels, the same trade follow-up and review, which already exists and is reusable). Largest gain.
2. **No clock for the evening.** Nothing says what is next and when: the US cash open at 19:00 IST (the USIB range ends), the EIA print, the time stop. **Do: a one-line strip on top of both desks**: the next event and its countdown, the session state (MCX open, closing at), and the strategy state.
3. **The chart is a general chart.** It shows tool chrome and does not hold the strategy's levels; the earlier design rule was "the chart never needs zooming, levels drawn by the app". **Do: a Levels study the panels feed** (the range, VWAP, previous day high and low, the trade's entry / stop / TP1 / TP2), and a "clean" chart mode for the desks (auto-follow, no drawing toolbar). Needs a small spike: a study cannot be refreshed from a panel's state yet.
4. **The option chain is the whole chain.** The job needs four or five strikes with premium, delta, OI, volume, IV, theta; the 12-wide panel shows 21 strikes and about 20 columns and spends 11 rows. **Do: a compact "strikes" view** (the same data, five strikes by delta, the OI walls named) so the chain gives the row back to the chart; keep the full chain on F3.
5. **Quote panel clips** (content 273 px in a 240 px body). **Do: give it 9 rows or drop the rarely used lines.**
6. **Chart state is not saved in this browser**: the chart's status line says "Saved chart settings could not be read, so changes are kept for this session only: no answer within 4000 ms" (the library's IndexedDB). Indicators, killzones and drawings would be lost on reload. **Check it in your own Chrome**: if it shows there too, it needs fixing before anything is added to the chart by default.
7. **Paper and the real trade are separate worlds.** Paper trading, the journal and the Report day record do not meet. **Do later:** one trade journal that both fill.

## Report day desk

1. **Bug: gas expiry.** The decision is crude on the nearest expiry, NATGASMINI on the next one (the nearest expires the day after the report). The panel read the nearest for both. **Fixed in this change** (the gas chain is read on the second expiry; tested).
2. **Premium levels were missing.** The owner's exit rule is the future's levels and a premium level, whichever comes first (R translated through the delta, fixed at entry). The trade block showed only the future's levels. **Fixed in this change**: stop, TP1 and TP2 on the premium are shown.
3. **The range and the levels are not on the chart** (same as Evening 3). On the print, the trader looks at the chart for the range and at the panel for the numbers. Highest value after USIB.
4. **The panel will scroll during the trade.** At prep it exactly fits (920 of 920 px); with the window table, the signal, the strike table and the trade block it is about 1,100 px. **Do: widen to 5 columns, and once a trade is open collapse the strike table to the pick and the number block to one line.**
5. **Strike table premium is polled, not live.** The in-trade follow uses the live option quote, but the table before entry uses the chain poll (1 to 3 seconds). **Do: ask the stream to watch the five strikes** (the chain panel already does this for nine).
6. **Nothing on the OI walls.** The owner's TP2 for USIB, and the "chain levels" idea, use round strikes and OI walls; the chain has the numbers (OI by strike) and the screen does not name the nearest wall above and below. **Do: show them in the strike block.**
7. **Not yet seen on a real release.** The print and window stages have only run on fake feeds; the first real run is Wed 28 Oct 20:00 IST. Anything wrong will show then; the checklist and the alerts are there to catch a dead source early.
8. **Winter time** (after 1 Nov the print is 21:00 IST): the screen follows the stored release time, and the time stop offsets are relative to the print, so it should hold, but it is untested until the clock change.

## Suggested order

1. USIB panel and a USIB desk section (or a mode of the Evening desk) reusing the trade follow-up: the biggest gap, and the strategy the owner runs most days.
2. The event / session strip on both desks.
3. The Levels study (range, VWAP, previous day, trade levels) and the clean chart mode; first check item 6 above.
4. The compact strikes view with OI walls; live premiums for the strikes.
5. Widen Report day and collapse blocks during a trade.

Each is a day-sized piece except the Levels study, which starts with a spike.
