# EIA report-day screen (step 2, on paper, 2026-10-22)

First wireframe, shown in the conversation as a clickable six-stage mock-up (numbers illustrative, not market data). One monitor, one screen that changes with the stage; nothing to open, nothing to zoom.

## Layout (one large monitor)

| Block | Where | Always shows |
|---|---|---|
| Stage strip | top | stage name and window, countdown to the next event, **day limit gauge** (Rs 1,000, used so far) |
| Future chart | left, about 63% wide | MCX future 5-minute candles with the **live candle, tick and price always in view** (the chart follows the last bar by default, no zooming needed), previous-day high and low, session VWAP, the last-hour range box, signal marker, entry / stop / TP1 / TP2 / trail once in a trade |
| Report block | right, top | forecast (typed in or from Forex Factory), actual, surprise against the 3.0M / 5.0 Bcf threshold, and which side is allowed |
| Option chain | right, middle | four strikes around the money, columns **premium, delta, OI, volume, IV, theta** only; the rule's suggested strike highlighted; the nearest OI wall named |
| Trade block | right, bottom | before entry: the signal and the strike to buy; in the trade: **option premium and rupee P&L**, the future against its levels, limit used, time-stop countdown; after: review |

## The six stages

1. **Prep** (17:00 to the range hour): thresholds, forecast field, the suggested strike with its premium against Rs 70,000.
2. **Range** (the hour before the print): range box drawn live with its width; chain re-checked about ten minutes before the print.
3. **Print**: actual, surprise and allowed side appear within seconds of the release; the chain is re-read.
4. **Window** (print to 30 minutes after): per-candle "inside / closed above / closed below"; signal when a close breaks the range on an allowed side; entry cut-off countdown; strike re-picked by the delta rule at that moment.
5. **In trade** (entered by hand): premium and Rs P&L first; limit gauge; alerts (sound and flash) at stop, TP1, TP2, trail move, limit reached, time stop. No order button.
6. **Done**: one trade or none; review view with the entry, exit and a note box; new entries locked until tomorrow.

## Design rules this wireframe commits to (to be tested on a replay, step 3)

- The **chart never needs zooming**: auto-follow the live bar, fixed visible window around it, price scale fitted to the visible bars; the last price is a label on the candle.
- **No tool chrome** on this screen: no drawing toolbar, no indicator list. Levels are drawn by the app from the rules.
- **Colour means state**, not decoration: blue = the range and live price, green = favourable, red = stop / limit, grey = reference levels.
- **Rupees before points** on the option; the future in points beside it.
- The limit gauge is on screen in every stage, because it is the thing that ends the day.

## Not designed yet

Gas-day differences (NATGASMINI, 5.0 Bcf, the same blocks with gas units); the non-report-day (USIB) screen; phone width; the settings (limit, cut-off, thresholds); the evening timeline view that links the stages; alert sounds.

## Gas-day variant (NATGASMINI, Thursday WNGSR) and a live chain check

The same six stages and blocks. What changes: surprise in **Bcf** against **5.0**; range and levels in points of 0.1; the limit gauge expressed also in R (1 R is only about Rs 190 to 230 on the option, so the Rs 500 to 1,000 limit is 2.5 to 5 R); alerts are mostly R-based, not limit-based.

Checked on the live chains (2026-10-22, daytime, so spreads are indicative):
- **Gas ATM is liquid and tight**: bid-ask 0.05 on a premium of about 4.6, i.e. Rs 12.5 per lot; volume 150,000 to 300,000 and OI 25,000 to 34,000 per strike. Not a problem.
- **Crude ATM spread is 1.3 to 1.5 points = Rs 130 to 150 per lot**, about 13 to 15% of the Rs 1,000 limit lost to the spread before the trade moves. Volume is a few thousand per strike.
- **Nearest expiry on a Thursday gas report day is the next day (23 Oct).** ATM theta is about -2.0 points = **Rs 500 a day on a Rs 1,150 premium: roughly 40% of the premium decays in a day**, and IV is near 100%. The delta rule (0.5 to 0.6) hides this. Gamma is also high, so delta moves fast. Your "nearest expiry" rule picks this contract; worth a conscious decision (open question below).
- **Crude ATM premium is about Rs 53,500 per lot** (535 points x 100; expiry 17 Nov), far above the Rs 31,600 in the wireframe, which was only a placeholder. That is 76% of Rs 70,000, so the "0.6 delta if the premium fits the capital" test matters on crude. Crude ATM theta is about -10 points = **Rs 1,000 a day per lot**, equal to the whole daily limit.

Settled (2026-10-22): **gas uses the next expiry, not the nearest** (the owner's answer; reading: always the second-nearest for NATGASMINI, `?` if it should be "second only when the nearest expires within a day or two"). **Crude keeps the nearest expiry and its premium (about Rs 53,500 ATM) fits the Rs 70,000 capital.** So the strike rule per instrument is: crude = nearest expiry, gas = next expiry; both ATM with |delta| at least 0.5, else the 0.6-delta strike when its premium fits.
