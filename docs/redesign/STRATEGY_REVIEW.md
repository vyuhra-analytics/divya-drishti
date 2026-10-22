# Review of the owner's strategies (before any hypothesis of ours is built on them)

2026-10-22. Scope: the two strategies in `USER_AND_JOBS.md`, read as a skeptical reviewer would, then a list of which of OUR assumptions (the "junior" work: the redesign findings, the screen ideas) rest on them.
Evidence labels: **measured** (from our stored 5-minute bars, 2026-09-21 to 2026-10-22, 22 evenings), **arithmetic** (follows from the owner's own numbers), **general knowledge** (not measured here, check before relying), **missing** (we have no data).

What we do NOT have: any trade record. The owner's text mentions an amendment history ("Amendment 3", "S2.1") and records kept by another session, but no `data/records/` exists in this repository. **So nothing below says whether the strategies make money. It only says where the rules disagree with themselves or with the market.**

## A. Findings that change the design

### A1. The R structure and the rupee limit are two different strategies (arithmetic + measured)
- Crude R = 1.5 x ATR(14) on the 5-minute future. Measured evening ATR: **median 20.8 points** (p10 16.3, p90 30.7). The 20 October example (ATR 36.5, R 54.8) was a **high-volatility day: ATR at 19:00 IST was 37.1 against a median of 20.7**. The stored bars agree with the owner's number, so the rule is being read correctly.
- At the median ATR, R is about 31 points = about **Rs 1,700 on the option** (100 bbl, delta 0.55); on 20 October about Rs 3,000. TP1 (+1R) is therefore Rs 1,700 to 3,000, while the daily profit limit is Rs 500 to 1,000 and the daily loss limit is the same size.
- With "(a) the limit is a hard stop", the trade is closed at Rs 500 to 1,000 profit or loss. That is **0.3 to 0.6 R on a median day and 0.17 to 0.33 R on a high-volatility day**. TP1, TP2, the trail and the breakeven move are then never reached. What is traded is "scalp to about Rs 1,000 either way", not the R-multiple strategy the rules describe. Any evidence gathered for the R rules (backtests, a track record) does not transfer.
- The owner should decide this knowingly. Either the real rule is the rupee scalp (then it needs its own test), or the R rules are the real strategy (then the limit must be larger, or the strike a lower delta).

### A2. A Rs 500 to 1,000 stop sits inside normal noise on crude (measured)
- Rs 1,000 on the option is about **17 to 20 future points**; Rs 500 is about **8 to 10 points**. Measured: the median evening 5-minute bar has a high-low range of **18 points**.
- Share of evening 5-minute bars whose own range is at least that: Rs 1,000 stop: **45% (delta 0.5) to 58% (delta 0.6)**; Rs 500 stop: **88% to 91%**. A stop that one ordinary candle can touch is hit by noise, not by being wrong. (A bar's range is not a drawdown from an entry, so this is a first pass; the real test is a replay with entries.)

### A3. Natural gas is the opposite case (measured + arithmetic)
- NATGASMINI evening ATR(14) 5m: **median 1.0 point** (R about 1.5 points). Lot 250 mmBtu. One R through delta is about **Rs 200 to 230 on the option**, far below the Rs 500 to 1,000 limit. The limit is never the binding constraint on gas; R is. The rules "crude and gas share one limit" produce a very different feel on the two. The terminal should show the limit as a number of R for the chosen instrument.
- The "price" of Rs 500 on gas is about 3.6 future points, about three ATRs: wide. A gas stop-out at 1 R is small; a gas win at 1 R is small. Costs (brokerage Rs 20 per order, both ways, plus the option spread) are a much larger share of a Rs 200 move than of a Rs 1,700 move (general knowledge about spreads; **missing**: the actual bid-ask on MCX NATGASMINI options, which the chain data we already store can tell us).

### A4. "USIB" is not an initial balance, and its range breaks at the clock change (arithmetic)
- An initial balance is the first hour **after** the open. The rule uses 18:00 to 19:00 IST, the hour **before** the US cash open (09:30 New York = **19:00 IST in summer**). That is a pre-market range, a different thing, and the name will mislead anyone (including the terminal's own labels).
- On **1 November 2026** (a Sunday, US clocks back) the US open moves to **20:00 IST**. The owner has said the time stop and the EIA print move one hour. **The 18:00 to 19:00 range was not said to move.** If it stays, the range ends an hour before the open and the strategy changes character; if it moves to 19:00 to 20:00 it needs saying. **Open question for the owner.**
- Related: MCX evening close is 23:30 in US summer time and 23:55 after the change; the time stops (21:30 to 22:00, then 22:30 to 23:00) are consistent with that.

## B. Rule gaps (the rules do not decide what to do)

1. **USIB signal**: a break of the 18:00 to 19:00 high or low, with volume at least 1.5x the previous ten candles and price on the right side of session VWAP. What if the break happens **before** 19:00 (in the range hour itself)? On a close or a touch? What if there is a break up and then a break down (one trade a day: the first, or none)? The rules say entry at the next 5-minute open after the signal candle.
2. **Report days**: USIB is "non-report days". Is Thursday a USIB day when the gas report is the trade? Is there a USIB trade on Wednesday and Thursday at all? What about weeks when the report moves (US holiday delays: the report is a day late after a Monday holiday, e.g. Thanksgiving week) or MCX is shut for a holiday?
3. **EIA direction**: "enter long or short on the first three candles after the print, breaking the last-hour range". Does the surprise (1M barrels, 1 Bcf) **decide the direction** (draw bigger than 1M = long only), or is it only a filter that "a surprise happened"? What if the surprise is small and the range breaks anyway? The thresholds are not used in the entry text.
4. **Entry timing and price**: signal on the candle close, entry at the next candle's open on the **future**, but the trade is in the **option**, bought by hand. The option fill is at the ask, seconds to a minute later, at a different price. The R levels are set from the future's entry; the option's real entry differs. Define the reference (option premium at the moment of the click).
5. **Strike pick**: "ATM if |delta| >= 0.5, or the 0.6 delta strike if the premium fits the capital" - what if ATM is **below 0.5** (the common case a little after the ATM strike moves)? Which side is chosen? Delta read where (Upstox's chain delta or ours)? Nearest expiry when the nearest is days to expiry (gamma and theta then dominate and the delta rule hides it)? **Missing**: how close to expiry the owner switches.
6. **Pre-report pick adjusted after the print**: the stated workflow takes up to 5 minutes, but the entry window is the first three candles (15 minutes) after the print, and the print moves the whole chain. The rules do not say whether the pre-report strike is kept or replaced by the delta rule at the entry time. (The delta rule applied at entry time is the consistent reading.)
7. **One trade a day vs two strategies**: the owner trades USIB at 19:00 to 20:00 on non-report days and EIA on report days, so one a day is consistent. State the rule for "USIB hit its limit, then the report prints"? (report days only trade the report, per the text).
8. **Time stop vs the rupee limit vs R stops**: with a hand exit there are four exits (limit, R stop, TP/trail, time stop). Say which one wins when two arrive together, and that "stop by touch" means touching the **future** level, which the owner converts to a premium by hand.

## C. Statements to check before they are repeated (accuracy)

| Claim | Status |
|---|---|
| EIA WPSR Wednesday and WNGSR Thursday at 10:30 ET | correct in the usual week (general knowledge; our calendar uses the same schedule); holiday weeks shift. |
| 10:30 ET is 20:00 IST in summer and 21:00 IST after 1 November | **verified by arithmetic** (UTC-4 to UTC-5; 1 Nov 2026 is a Sunday). |
| US cash open 19:00 IST in summer, 20:00 IST after | verified by arithmetic. |
| "Crude (standard) options and NATGASMINI options are available" | not checked; **missing**: liquidity (volume, open interest, bid-ask) per strike for NATGASMINI options in the evening, which our chain recorder partly holds. |
| ATR 36.53 gives R 54.8 | 1.5 x 36.53 = 54.8: correct; and our stored bars give ATR 37.1 at 19:00 on that day: the same order, so the stored data matches the strategy's records. |
| A 1M barrel and 1 Bcf surprise as the threshold (**superseded: the owner now uses 3 MB and 5.0 Bcf**) | **general knowledge, not measured**: typical forecast errors are a few million barrels for crude and a few Bcf for gas, so 1 Bcf in particular is probably exceeded on most weeks and may filter little. **Missing**: no forecast history is stored; we would need it to say. |
| Delta 0.5 to 0.6 at the money | fine for a call. For a put the owner means -0.5 to -0.6, recorded that way. |
| "One lot, Rs 70,000" | the premium of an ATM crude option (about 100 x premium) is in the range of Rs 20,000 to 40,000 (general knowledge, to be checked on a real chain); gas mini premiums are a few thousand. Capital is not the binding constraint; the daily limit is. |

## D. What of OUR work rests on these (the junior hypotheses) and how sure they are

| Our assumption (in `USER_AND_JOBS.md` / `ASSESSMENT.md`) | Rests on | Status after this review |
|---|---|---|
| "The premium, not R, is the real risk rule" | A1 | **Supported** by the owner's own numbers, but it is a **conclusion about the rules, not a measurement of results**; confirmed by the owner's decision (a). |
| The terminal should show "the limit in R" and "if the future reaches the stop, this option is worth X" | A1, A3 | Supported; needs a chain with delta and the lot sizes. |
| Strategies are mechanical so the terminal can run them live | rules B1 to B8 | **Only partly.** Eight places above are not decidable by code; the strategy monitor cannot be specified until they are. |
| A strategy monitor with levels (VWAP, ATR, R, entry, stop, TP1, TP2, trail) | rules as given | Fine to design, but the **levels the owner acts on are the rupee limit and the option premium**, so the monitor must lead with those, not with R. |
| Paper must mirror a bought option | the trade is a bought option | Unchanged. |
| 5-minute future chart is the signal chart | rules | Unchanged. |
| Evening timeline fixed at 18:00 to 19:00 | A4 | **Wrong after 1 November unless the owner says it moves.** |

## E. Next, in order

1. Owner decides A1 (which strategy is really traded) and A4 (does the range move on 1 November).
2. Fill B1 to B8 (a short list of yes/no answers).
3. Measure, from data we hold or can fetch: option bid-ask and OI on MCX crude and NATGASMINI chains in the evening (spread as a share of the Rs 500 to 1,000 limit), 5-minute ATR on report days, and the distribution of the move in the first 15 minutes after each print (EIA actuals and the forecast are already in the calendar code; the history needs to be recorded).
4. A replay test of the *actual* rules (rupee-capped scalp) on the stored bars, with entry fills at the next open and an assumed spread, only after 1 and 2. It will be a small sample (22 evenings of 5-minute bars) and says so.
