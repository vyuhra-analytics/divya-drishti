# EIA report-day strategy (spec on paper, 2026-10-22)

Built only from the owner's own rules (`USER_AND_JOBS.md`). Anything the owner has not said is marked `?`. No code.

> **Update 2026-10-22:** the risk rule is now R multiples with a Rs 2,000 per-trade cap. The replay sections below were written under the Rs 500 / Rs 1,000 limits and are kept as history; the R replay is in `SETTINGS.md`.

## The rules as the owner gave them

- Crude (standard) options on **WPSR** (Wednesday), NATGASMINI options on **WNGSR** (Thursday), print at 10:30 New York = **20:00 IST until 1 Nov 2026, 21:00 IST after**.
- Surprise = actual against a free calendar's forecast. Threshold: **crude 3 million barrels, gas 5.0 Bcf**.
- Range = high and low of the **last hour before the print**. Go long or short on a break of it during the **first three 5-minute candles after the print**.
- Strike: at the money if |delta| >= 0.5, or the 0.6-delta strike if its premium fits the capital; evaluated before the print and adjusted after, in at most 5 minutes. Nearest expiry. One lot.
- Exits by hand (updated 2026-10-22): stop at **1R** (R = 1.5 x ATR(14) of the 5-minute future at the signal candle, translated to the option through delta); **TP1 at +1R then the stop moves to entry; TP2 at +2R**; time stop 21:30 to 22:00 IST (22:30 to 23:00 after 1 Nov); a **Rs 2,000 cap on the loss of one trade** (lower-delta strike or no trade when 1R exceeds it). The earlier Rs 500 / Rs 1,000 daily limits are gone. One trade a day, then done.

## The day as a state machine (what a terminal can show)

| State | Starts | What the screen must show |
|---|---|---|
| PREP | 17:00 | forecast and previous for the report, the 3 MB / 5.0 Bcf thresholds, nearest expiry, chain with delta, OI, volume, IV, theta, a suggested strike with its premium against Rs 70,000 |
| RANGE | 1 hour before the print | the live range (high, low, width), the countdown to the print, the strike pick re-checked |
| PRINT | the print | actual against forecast, the surprise in barrels or Bcf, and whether it passes the threshold, within a second of the release |
| WINDOW | the print to +15 minutes | the three candles, the range lines, "closed beyond high / low" per candle |
| IN TRADE | by hand | option premium and rupee P&L, the result in R, the future against entry / stop / TP1 / TP2, countdown to the time stop |
| DONE | after the exit | review: what happened, no new entries |

## What the replay on stored bars shows (descriptive, 4 Wednesdays and 4 Thursdays, **not evidence of an edge**)

Rule used for the replay (my reading, `?` where it is a guess): range = 19:00 to 20:00 IST; a 5-minute close beyond it in the first three candles after 20:00; entry at the next candle's open; ride to 21:30; option move = future points x lot x 0.55. Surprise and direction are ignored because no forecast history is stored.

| Day | Range width | Entry | Best / worst / at 21:30 (option Rs) |
|---|---|---|---|
| Crude 23 Sep | 106 | none | |
| Crude 30 Sep | 83 | none | |
| Crude 7 Oct | 103 | short after candle 1 | +3,740 / -660 / +3,135 |
| Crude 14 Oct | 32 | short after candle 3 | +495 / **-3,465** / -1,485 |
| Crude 21 Oct | 99 | none | |
| Gas 24 Sep | 3.4 | long after candle 3 | +2,612 / -14 / +1,774 |
| Gas 1 Oct | 2.4 | none | |
| Gas 8 Oct | 4.3 | short after candle 2 | +660 / -83 / +646 |
| Gas 15 Oct | 5.6 | none | |
| Gas 22 Oct | no data yet | | |

What this shows about the rules, not about profit:
1. **The crude range is huge.** On four of five Wednesdays the 19:00 to 20:00 range was 83 to 106 points, about **three median R**, because **19:00 IST is the US cash open**: the "last hour before the print" contains the open's volatility. After 1 November the same window (20:00 to 21:00) again contains the open. The range does not describe a quiet pre-report market. 3 of 5 days had no entry at all.
2. **The one crude loser** (14 Oct, a narrow 32-point range) ran 63 points against the entry: **Rs 3,465 on the option, 3.5 to 7 times the Rs 500 to 1,000 limit**. Decision (a), the hard rupee stop, is what stands between that trade and the damage; without it the rules lose a multiple of the daily limit in one trade.
3. **Gas ranges are small (2.4 to 5.6 points, about 2 to 4 ATR)** and gas entries moved Rs 650 to 2,600 in the option's favour before the end, with almost no adverse move in the two taken. Two trades prove nothing, but they show the gas side is not a copy of the crude side.
4. **Four of eight days had no entry**, so "one trade a day" is often "no trade".

## Answers (2026-10-22, second round)

| # | Answer | Recorded as |
|---|---|---|
| 1 | "Yes, trade also for range breaks" | Surprise beyond 3 MB / 5.0 Bcf sets the direction (draw / storage below forecast = long; build / above = short). **A range break alone is also enough to trade** when the surprise is under the threshold. `?` when a big surprise points one way and the range breaks the other: take it, skip it, or wait for the matching side? |
| 2 | Full last hour | Range = high and low of the hour before the print |
| 3 | 5-minute close beyond the range | Break rule |
| 4 | Future's next open | Entry reference (the option is then bought by hand at its ask) |
| 5 | If no break, wait until the time stop | **The entry window is the whole time from the print to the time stop**, not only the first three candles (the earlier "first three candles" answer is replaced) |
| 6 | tradingeconomics / investing.com / in.investing.com | Forecast sources for the surprise. **Not yet connected**: our calendar reads Forex Factory. These three sites have no free keyless API; reading them from a script is against the terms of most of them and is blocked often. `?` which one the terminal shows (see open items) |

## Replay of the answers on stored bars (4 Wednesdays, 3 Thursdays, descriptive only, direction not filtered by surprise)

Rule: first 5-minute close beyond the last-hour range from the print to 21:30, entry at the next open, ride to 22:00, option move = future points x lot x 0.55.

| Day | Break | Best / worst / at 22:00 (option Rs) |
|---|---|---|
| Crude 23 Sep | long, +55 min | +1,210 / -1,265 / -110 |
| Crude 30 Sep | long, +45 min | +990 / **-2,860** / -1,375 |
| Crude 7 Oct | short, +0 min | +5,885 / -660 / +4,015 |
| Crude 14 Oct | short, +10 min | +495 / **-3,465** / -2,420 |
| Crude 21 Oct | short, +55 min | +935 / **-3,465** / -2,805 |
| Gas 24 Sep | long, +10 min | +2,612 / -14 / +1,774 |
| Gas 1 Oct | short, +20 min | +344 / -206 / +302 |
| Gas 8 Oct | short, +5 min | +1,004 / -83 / +935 |
| Gas 15 Oct | no break by 21:30 | |

Reading it (five crude days, three gas days: **a pattern to test, not a result**):
1. **Crude: four of five days went against the entry by Rs 2,800 to 3,500 at some point**, that is three to seven times the daily limit. With the hard rupee stop (decision a) each of those four days would have been closed at Rs 500 to 1,000 loss, if the adverse move came before the favourable one (the table does not give the order; the replay with the stop and the real order is the next step).
2. **The only clean crude win was the break at +0 minutes** (the print itself). The breaks at +45 and +55 minutes lost. Late breaks look like fakeouts; the owner's wish to wait until the time stop may be adding the worst entries. Five days only.
3. **Gas: all three entries were winners at 22:00** (Rs 300 to 1,800), with a worst adverse move of Rs 14 to 206. Three trades.
4. **After the clock change** the whole schedule shifts one hour later in IST; the replay data is all summer time, so none of this is tested on the winter alignment.

## Third round (2026-10-22): settled, with defaults I chose where the owner did not

| # | Owner | Recorded as |
|---|---|---|
| 1 | "not sure what the professional approach would be, move on" | **My default, to be changed freely:** when the surprise points one way and the range breaks the other, **skip that break** (price disagrees with the number: the market is weighing gasoline, distillates or Cushing, or priced the number in) and take only a later close beyond the range **on the side the surprise points to**, inside the entry window. A range break with a surprise under the threshold is still tradable on either side (the owner's earlier answer). |
| 2 | "set a cut-off" | **No new entry later than 30 minutes after the print** (20:30 IST in summer, 21:30 after 1 Nov). My choice, because the replay's crude losses came at +45 and +55 minutes and the winner at +0; five days is a thin reason, so it is a setting, not a rule carved in stone. |
| 3 | the three sites again | **The terminal never scrapes them.** Forecast is read from Forex Factory when it lists the report (already in the calendar), and there is **always a typed-in field** for the number you read on Trading Economics / Investing.com; a typed value wins. Three buttons open the three sites. |
| 4 | agreed | In review, if a stop and a target fall in one 5-minute candle, the stop is assumed first. |

## Status

The EIA report-day rules are complete enough to design the screen. Not decided and not needed yet: the exact premium level for the nominal stop (the rupee limit overrides it), how the strike is shown when ATM is under 0.5 delta (design step), winter-time behaviour (checkable only after 1 November).
