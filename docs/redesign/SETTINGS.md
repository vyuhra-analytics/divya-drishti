# Settings (step 2, on paper, 2026-10-22)

Two kinds: **rules** (they change what the strategy does or how much you can lose) and **display** (they change how it looks).

## Rules (locked during trading hours)

| Setting | Default | Notes |
|---|---|---|
| Daily loss limit | **Rs 500** | Hard stop on the open option: the trade is closed by hand when reached (the terminal alerts); the day is then done. |
| Daily profit limit | **Rs 1,000** | Same, on the profit side. |
| Capital | Rs 70,000 | Used for the premium-fits test and the premium shown against capital. |
| Crude surprise threshold | 3.0 million barrels | EIA WPSR. |
| Gas surprise threshold | 5.0 Bcf | EIA WNGSR. |
| Entry cut-off | 30 minutes after the print | A setting, not carved in stone. |
| Delta target | 0.5; 0.6 when the premium fits the capital | Calls positive, puts negative. |
| Expiry rule | Crude: nearest. Gas: next. | |
| Time stop window | 21:30 to 22:00 IST; 22:30 to 23:00 after the US clock change | Follows US daylight saving automatically. |
| Forecast source | Forex Factory, or typed in | The terminal never scrapes the other sites. |

**Lock rule (owner: yes).** From 17:00 to 23:30 IST (the evening session) the rules cannot be loosened. My refinement, a normal desk practice, to confirm: **tightening is allowed at any time** (a lower loss limit, a lower profit limit, a shorter cut-off), **loosening waits until the next day**. A change made in the evening that loosens a rule shows "applies from tomorrow 17:00".

## Display and alerts (never locked)

Up / down colours, clock format (12 / 24 hour), density, theme, alert sounds and flash, window length is **not** a setting (fixed 48 bars).

## What the owner's numbers imply (arithmetic and measured, flag)

- **A Rs 500 loss on one crude lot is 8 to 10 future points** (100 bbl, delta 0.5 to 0.6). Measured on the stored bars: **88 to 91% of evening 5-minute candles have a range at least that large.** A Rs 500 stop is inside the noise of a single candle: it will be hit often, including by trades that would have worked. Rs 1,000 on the profit side is about 17 to 20 points, so the loss limit is **half** the profit limit: the strategy needs a win rate near 67% to break even before costs and the spread (Rs 130 to 150 per crude lot round trip, about a quarter to a third of the Rs 500). This is arithmetic from the owner's own settings, not a forecast; it is the first thing the replay test (step 3 and later) should measure.
- **On gas** Rs 500 is about 3.6 points (about three ATRs) and Rs 1,000 about 7 points; the limits are wide there, so gas trades are governed by the R levels and the time stop, not the limit.
- **Two limits mean three day-end states**: done on loss, done on profit, done on time/no trade. The review view names which one ended the day.
