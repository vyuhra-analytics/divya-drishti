# Settings (step 2, on paper, 2026-10-22)

Two kinds: **rules** (they change what the strategy does or how much you can lose) and **display** (they change how it looks).

## Rules (locked during trading hours)

| Setting | Default | Notes |
|---|---|---|
| Stop | **1R** | R = 1.5 x ATR(14) of the 5-minute future at the signal candle; the stop is 1R from the future entry, translated to the option through delta (changed 2026-10-22: the Rs 500 / Rs 1,000 daily limits are gone). |
| Targets | **TP1 +1R, then the stop moves to entry; TP2 +2R** | No separate profit limit. One trade a day, so the day ends with the trade. |
| **Max loss per trade (cap)** | **Rs 2,000** | If 1R through delta, plus the spread, exceeds the cap, the screen warns and suggests a lower-delta strike (below your 0.5 rule); if none fits, no trade. A backstop alert also fires if the option loss reaches the cap. |
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

## What the R rule and the cap imply (2026-10-22; replaces the older analysis of the Rs 500 / Rs 1,000 limits)

- **Why it changed:** a Rs 500 loss on one crude lot is about a 7-point future stop with the spread included (a median evening 5-minute candle is 18 points); the two EIA Wednesdays with an entry (7 and 14 Oct) hit it first, including the day that later moved 68 points the right way. The owner chose R multiples.
- **Replay of the R rules on the same two days** (stop first inside a candle, delta 0.5, spread Rs 140, time stop 22:00): 7 Oct, TP2 at +2R, about +Rs 2,900; 14 Oct, stopped at -1R, about -Rs 1,550. Two trades, not an edge.
- **1R in rupees moves with volatility:** about Rs 1,550 to 1,700 at the median ATR (R about 31 points), about Rs 2,900 at R 54.8 (20 Oct, delta 0.5). Above the Rs 2,000 cap the strike must have a lower delta: about 0.33 on that day (the prototype's simulated chain puts that strike far out of the money; the real chain decides).
- **Gas:** R is about 1.5 points, 1R about Rs 190, far inside the cap; the cap does not bind on gas.
- **Day-end states** (the review names which one ended the day): stopped at -1R, stopped at entry after TP1, TP2, time stop, cap backstop, no trade.
