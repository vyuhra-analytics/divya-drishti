# The user and the jobs (step 1 of the redesign)

Filled in from the owner's own answers. Anything not yet answered is marked `?`. Nothing here is assumed.

## Answered (2026-10-22)

| Question | Answer |
|---|---|
| What is traded | **Buying options** (CE or PE) on MCX: crude (standard) options and NATGASMINI options. **One lot, fixed, always.** The signals and levels are read on the **future's** 5-minute chart; the option is the instrument bought. |
| Real capital | **Rs 70,000.** The capital a trade needs is set by the premium of the strike bought (premium x lot size), so it varies by strike and day. |
| Style, session | **Intraday**, **MCX evening, 17:00 to 23:30 IST** |
| Daily limits | **Superseded 2026-10-22:** the Rs 500 / Rs 1,000 daily limits were replaced by **R multiples (stop 1R, TP1 +1R then stop to entry, TP2 +2R) with a Rs 2,000 cap on the loss of one trade**. One trade a day. |
| Per-trade loss | Set by the strategy (stop at entry minus or plus R on the future), not by a rupee rule |
| Screens | **One large monitor** |
| Tools today | **TradingView** (dislikes) and **Upstox web or desktop** (likes) |
| On TradingView | The chart is **messy** and needs **constant zooming in and out** to see the current candles, the tick and the price. It is only a chart. |
| On Upstox | **Tidy and clean, with all the information a trader needs.** |
| Strike bought | **Chosen by delta: +0.5 to +0.6 for a call, -0.5 to -0.6 for a put** (at the money, a little in the money) |
| Option exit | **Both: the future's levels and a premium level, whichever comes first** |
| Expiry | **Crude: the nearest expiry. Gas (NATGASMINI): the next expiry** (decided 2026-10-22 after the nearest was found to expire the day after the report) |
| EIA consensus for the surprise | **A free calendar site's forecast figure** (our calendar already shows the forecast from Forex Factory, a free source) |
| EIA surprise that counts | **Crude: plus or minus 3 million barrels; gas: plus or minus 5.0 Bcf**, against the forecast (changed 2026-10-22 from 1M and 1 Bcf, after the review found 1 Bcf too small to filter) |
| Time stop | **Between 21:30 and 22:00 IST, for both strategies** (the exact rule inside that half hour, and what it becomes after the clock change on 1 November: `?`) |
| "Chain levels" for TP2 | **A combination of round strikes and open-interest walls** |
| Gas surprise that counts | superseded: **plus or minus 5.0 Bcf** (see above) |
| Option exit levels | **R translated to the option's premium through delta** (premium stop and targets = R x delta from the entry premium). **Owner: "take the professional's approach"**, which I read as: delta read once at entry and the levels fixed from it (placed as real levels, not recomputed), and the daily rupee limit enforced as a hard cap on top (see open item) |
| Time stop after 1 November | **Moves to 22:30 to 23:00 IST**, in step with US daylight saving |
| USIB entry | **One trade a day**, entered on a break of the **high or low of the 6 PM to 7 PM IST range** |
| EIA entry | **Wait for candlestick confirmation over the first three 5-minute candles** after the print |
| OI-wall rule | **OI**: open-interest walls |
| EIA entry, restated | **Pre-report high/low range; go long or short on the first three 5-minute candles after the print** breaking it (pre-report window: **the last hour before the print**) |
| USIB range and filter | **High and low of 18:00 to 19:00 IST; entry needs volume at least 1.5x the previous ten candles and price on the right side of session VWAP** (above for long, below for short; confirmed) |
| Funds | **Buying options: the premium is paid in full**; Upstox "funds" is just the premium |
| Daily limit vs option stop | Superseded 2026-10-22 (was: the Rs 500 to 1,000 limit as a hard rupee stop). Now: the 1R stop and the Rs 2,000 cap rule; see `SETTINGS.md`. |

## The two strategies (in the owner's words, kept exactly)

Both run on report or non-report days in the evening session. The owner's wording:

> Currently, two strategies trade EIA WPSR/WNGSR Surprise post reports from 8 PM to 9:30 PM, with a maximum of 10 PM on report days, which are typically
> Wednesday and Thursday. Second Strategy: Use V to trade the pre-US session candle between 6 and 7 p.m.

### 1. USIB: US-Open Initial Balance breakout

> USIB stands for US-Open Initial Balance breakout. For Crudeoil and Natural Gas, it is a non-report-day crude strategy.
>
> Future 5-minute chart with session VWAP (hlc3) and Volume ATR (14) indicators. At least 1.5 times the volume of the previous ten candles. One trade and one signal every day.
>
> Entry is when the subsequent five-minute candle opens following the signal.
> R: 1.5 x ATR(14) at the end of the signal candle. For instance, on October 20, ATR 36.53 yielded R 54.8.
> Stop: touch entry -/+ R.
> TP1: entry +/- 1R, and the stop is moved to the entry.
> The next chain level after TP1 and at least 0.5R beyond it, or 2R, is TP2 (rule in effect, S2.1). This is the only modification made by Amendment 3.
> Trail: updated at each candle close and never loosened, the stop is the best 5-minute close minus 1 ATR from TP2.
> Exit: a single position that is closed by a time stop or an initial, breakeven, or trailing stop. There are no partial exits. The exit is by touch, but the trail updates when it closes.

### 2. EIA report strategy: B1 breakout on the report

> EIA report strategy is B1 breakout on WPSR (crude) on Wednesdays and WNGSR (gas) on Thursdays at 10:30 ET following report printing. Crude (standard) options on
> WPSR days and NATGASMINI options on WNGSR days are available at 20:00 IST in the summer and 21:00 IST after November 1.

## What this changes in our understanding

1. **We have been designing for the wrong instrument.** The app is built around futures. The traded instrument is an **option**, bought, one lot. What matters is the option's
   premium, its P&L in rupees, and where it sits against the day's Rs 500 to 1,000 limit, while the **signals are read on the future**. The terminal has to show both
   at once and relate them.
2. **The strategies are rules, so the terminal can run them.** Both are mechanical. A strategy monitor on one screen can show, live, which state each is in (waiting,
   signal, entered, TP1 hit, trailing, exited), the levels (VWAP, ATR, R, entry, stop, TP1, TP2, trail), and the countdowns. That is the centre of the redesign, not a
   generic watchlist.
3. **The chart is what the owner dislikes about TradingView, and our default chart is a TradingView-style widget.** Messy chrome, a need to zoom to see the live edge. The
   Upstox chart, clean with everything needed, is the reference. A chart that always keeps the live candle, tick and price in view, with almost no chrome, is a requirement.
4. **Risk is in rupees on the option, and may not line up with R on the future.** For illustration only (strike and delta unknown, my arithmetic): with R = 54.8 points
   on crude (100 bbl), a futures move of one R is about Rs 5,480. An at-the-money option moves roughly half of that, so about Rs 2,700 per R, which is above a Rs 500 to
   1,000 daily limit; an option with a delta near 0.2 would lose about Rs 1,100. Which strike is bought decides whether one stop-out can break the daily limit. The terminal
   should show this **before** the trade, as "if the future reaches the stop, this option is worth about X".
4b. **The numbers the owner has now given show the premium, not R, is the real risk rule.** With a delta of 0.5 to 0.6 on a 100 bbl crude option, one R (54.8 points on
   the future) is worth about Rs 2,700 to 3,300 on the option: **2.7 to 6.6 times the Rs 500 to 1,000 daily loss limit**. A Rs 1,000 loss is about 10 points of premium, which
   is only about 18 points on the future, roughly a third of R. The same on the profit side: Rs 500 to 1,000 is reached at about 0.17 to 0.33 R, **well before TP1 at 1 R**. So
   either the daily limits are exits for the open trade (the trade is closed when its P&L reaches them), or they only stop new trades and the R structure runs on. These
   two readings need very different screens. (My arithmetic, delta taken as 0.55, one lot of 100 bbl; to be confirmed against real premiums.)
5. **The timeline is exact.** USIB: pre-US-session candle (6 to 7 pm IST), signal on 5-minute candles, one trade a day, non-report days. EIA: the report prints at
   10:30 ET, which is 20:00 IST in summer and 21:00 IST from the US clock change (1 November), trade window to about 21:30 or 22:00 IST. The app's calendar is already
   daylight-saving aware; the terminal must show the countdown to the print and the trade window as the dominant element on report days.
6. **Paper should mirror this.** Paper trading today simulates futures. It would have to simulate buying one lot of an option, with the real premium and the real costs,
   to say anything about these strategies. (Costs: the cost model has an options branch, to be checked.)
7. **The other Claude session** (the one that asked for tags, client order ids and trailing stops) is where these strategies are being researched and recorded in
   `data/records/`. Its R, TP1, TP2 and trail rules are the same ones above.

**Update 2026-10-22: the daily limits (Rs 500 / Rs 1,000) were replaced by R multiples with a Rs 2,000 per-trade cap. Notes below that mention the limits are history.**

**Focus (2026-10-22): the EIA report-day strategy first.** Its spec and the replay on stored bars are in `EIA_STRATEGY.md`.

## The evening session, in the owner's words (2026-10-22)

1. **Before 18:00**: "check" (the owner checks the market and the calendar; detail not given).
2. **18:00 to 19:00**: marks the **high and low** of the hour (the USIB range; for EIA days the last hour before the print).
3. **Screen at the signal**: the **futures chart**, **previous day high**, **previous day low**, and the **option chain showing, per strike, open interest, volume, delta, implied volatility and theta**.
4. **Strike pick**: the **at-the-money strike if its delta is at least +/-0.5**, or the **0.6 delta strike if its premium is below the capital available**. Takes **at most 5 minutes**. The chain is **evaluated before the report and adjusted after it** when picking.
5. **In the trade**: watches the **option premium** and the **future contract's move**.
6. **Exit**: **by hand**. **One trade a day**: stops for the day after it, in profit or loss.

What this adds to the design: the live-trade screen is two numbers side by side, option premium (P&L in rupees against the day's limit) and the future with its levels; exits are manual, so the terminal advises (alerts at stop, TP1, TP2, time stop and the rupee limit) and never places orders; one trade a day means the day has two states, "waiting for the signal" and "done", and the terminal locks to a review view after the exit.

Also: the signal screen is exactly four things (future chart with the previous-day high/low drawn on it, the hour's range, a trimmed option chain, the day's limit). The chain needs six columns (OI, volume, delta, IV, theta, plus premium), not the 15-column detailed chain. The strike rule is mechanical (ATM with |delta| >= 0.5, else the 0.6 strike when its premium fits the capital), so the terminal can suggest the strike and show its premium against the capital. A pre-report mode that picks a strike in advance, then re-checks it after the print, is a real workflow.

## Unclear, to ask

Nothing blocking step 2. To settle there: one daily limit number or separate loss and profit limits; lock out or only warn after the one trade; whether the terminal should record the trade for review (a journal) and what is written.

Step 1 complete.
