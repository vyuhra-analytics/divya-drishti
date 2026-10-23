# Pre-registration: does headline sentiment carry tradable information for crude?

Written and committed to git **before any result of the study was seen**. The commit timestamp is the evidence of that. Nothing below may be
changed after the data audit or any experiment has run; a deviation is a new entry in the log at the bottom, never an edit.

## Disclosure of what the author already knew

When this was written the author (an AI assistant) already knew, from earlier in the same project, that the news archive holds about 1,900 headlines
and starts on 2026-10-19 (three trading days), and that its timestamp is the feed's publish time, not the time we first saw the story. The data
sufficiency thresholds below come from a power analysis, not from the audit.

## Question

Does headline sentiment (FinBERT, CrudeBERT, and a simple word-list baseline) carry information about subsequent crude-oil returns, net of MCX
trading costs, at horizons from 15 minutes to 1 day? Qlib is evaluation scaffolding only. Reinforcement learning is out of scope.

## Definitions (fixed)

- **Event**: a deduplicated headline (the earliest copy of a story, as the news archive already collapses them) tagged `crude` or `oil`.
- **Event time** `t0` = the later of the feed publish time and our first-seen time. If first-seen is not recorded for an event, the publish time is used
  and the event is flagged `unverified_time`; flagged events are analysed separately and can never carry a claim.
- **Entry**: the open of the first 1-minute bar that starts at least 60 seconds after `t0` (assumed latency). Never the bar containing `t0`.
- **Forward return** over horizon `h`: close of the bar at entry + `h`, divided by the entry open, minus 1, in the contract's own units.
- **Tone** of a headline: for the two neural models, P(positive) minus P(negative), in [-1, 1]. For the baseline: (positive words - negative words) /
  (positive + negative + 1) from the Loughran-McDonald finance word lists.
- **Independent events**: events at least 15 minutes apart in the same instrument's market hours (a later event inside 15 minutes of an earlier one is
  dropped from the independent set), because headlines cluster around the same news.

## Hypotheses

- **H1 (primary)**: the rank correlation (Spearman IC) between tone and forward return is greater than zero for the best-performing model at the
  primary cell. **H0**: it is zero.
- **Primary cell**: instrument MCX CRUDEOIL front contract, horizon 60 minutes. Every other cell is secondary and is reported but can never make the claim.

## Test family and multiple-testing control

3 tone sources (FinBERT, CrudeBERT, word-list) x 3 horizons (15 min, 60 min, 1 day) x 2 instruments (MCX CRUDEOIL, NYMEX CL) = **18 tests**.
Holm-Bonferroni correction over all 18, family alpha 0.05 (the Bonferroni equivalent is 0.00278 per test, z = 2.991). **Trial counter starts at 18**;
every extra variant tried (a threshold, a window, a model) adds one and widens the correction. The deflated Sharpe ratio below uses this count.

## Baseline ladder (a tone signal counts only if it beats all of these, net of costs)

1. No trade (zero).
2. Buy and hold the front contract over the same period.
3. Random entries: same number of trades, same holding time, random direction (10,000 permutations).
4. Headline-count signal: trade the direction of the previous 15-minute return whenever there is a headline (tests whether "a headline happened" is the information).
5. Word-list tone (Loughran-McDonald).
6. Tone shuffled across events (negative control: must give IC near zero).

## Trading rule used to turn tone into money (fixed, no tuning)

Long when tone >= +0.5, short when tone <= -0.5, otherwise no trade. Hold for `h`, exit at the close of that bar. One lot of CRUDEOIL (or CL
scaled to the same notional for the comparison only). Costs: the full Upstox MCX schedule from `costs.ts` for each round trip, plus slippage of
1 tick on each side. The 0.5 threshold is not to be optimised.

## Data sufficiency gate (the audit must pass ALL of these or the experiments do not run)

From the power analysis: to detect a rank IC of 0.10 with 80% power at the per-test alpha of 0.00278 one needs about **1,462 independent events**; an
IC of 0.05 needs about 5,870; an IC of 0.03 needs about 16,300.

1. At least **1,500 independent events** in the primary cell (so only an IC of about 0.10 or more can be claimed; a smaller one is reported as "not detectable with this sample").
2. They span at least **60 trading days** and include at least two volatility terciles (so the result is not one calm week).
3. Timestamps: either first-seen is recorded for the events, or the publish time is validated against an independent clock (the same stories in an
   independent archive) with a **median lag of 5 minutes or less**. Otherwise all events are `unverified_time` and no claim is possible.
4. Price data: 1-minute bars present for at least **99%** of minutes of the MCX session on the days used, no unexplained gaps, contract rolls accounted for.
5. No look-ahead: a test that shifting every event time forward by 1 hour changes the forward returns used (proves the pipeline reads time correctly).

If any item fails, the experiments are not run, the thresholds are not relaxed, and the report is the data-acquisition plan.

## Success criteria for a positive verdict (all required, in the primary cell)

- Holm-adjusted p < 0.05 for IC > 0 and IC >= 0.05 in size.
- Mean net P&L per trade > 0 with the lower end of the 95% bootstrap interval > 0, after the full cost stack.
- Deflated Sharpe ratio probability >= 0.95 using the trial counter.
- Probability of backtest overfitting < 0.20 (combinatorial purged cross-validation).
- Superior-predictive-ability test against the whole baseline ladder, p < 0.05.
- Same sign of IC in both halves of the period.
- Positive control passed: the published CrudeBERT thesis result (or a published reproducible sentiment/return result) is replicated within its reported tolerance
  on its own data using our pipeline.
- Negative control passed: shuffled tone gives |z| < 2.
- A second implementation of the IC and P&L calculation (a different library) agrees with the first to 4 decimals.

A result that meets some but not all is reported as **inconclusive**, not as a weak positive.

## Stopping rules and conduct

- No tuning after seeing results. No dropping of events, periods or instruments after seeing results.
- A negative or inconclusive verdict is a complete result and is written up in full.
- Model weights are used locally and are never committed to the repository (FinBERT: CC BY-NC-SA 4.0; CrudeBERT: licence not stated).
- Nothing in this study connects to a broker.

## Log of changes and trials

| date | entry |
|---|---|
| (at commit) | pre-registration written; trial counter = 18 |
| 2026-10-22 | data audit run (see DATA_AUDIT.md): gate items 1 to 4 failed, item 5 not run; experiments NOT run; thresholds unchanged; trial counter still 18 |
| 2026-10-23 | data audit re-run (see DATA_AUDIT.md): 175 independent in-session events (52 with a verified time), 4.5 trading days: gate items 1 to 4 still fail; experiments NOT run; thresholds unchanged; trial counter still 18 |
| 2026-10-23 | **Deviation D1, logged before any GDELT data was fetched and before any result exists.** Owner approved the acquisition plan of DATA_AUDIT.md (steps 2 and 3). (a) **Event source**: GDELT GKG 15-minute files (data.gdeltproject.org/gdeltv2), the page title of each article. (b) **Relevance rule, fixed now**: keep a title if it matches the crude-market word list and does not match the non-crude word list in `packages/shared/src/gdelt.ts` (`CRUDE_TERMS`, `NONCRUDE_TERMS`); the GKG themes are stored but not used to select. Changing either list later adds a trial to the counter. (c) **Event time** t0 = the GDELT batch time (when GDELT processed the article, a 15-minute clock), the later of that and nothing else; every GDELT event is verified-time by gate item 3 as an independent clock, with a stated resolution of 15 minutes. (d) **Dedup**: the earliest batch containing a normalised title (publisher suffix removed) is the event; later copies are dropped. (e) **Primary cell moves to NYMEX CL** (Yahoo hourly bars, about two years); MCX CRUDEOIL has too little history and stays only the tradable translation (costs, lot). (f) **Horizons**: 15 minutes is dropped (it is below the clock resolution); 60 minutes and 1 day stay. (g) **Test family** becomes 3 tone sources x 2 horizons x 1 instrument = 6 tests; the **trial counter stays at 18** (it is not reduced, so the correction is not weakened). (h) Roll handling: Yahoo CL=F is a spliced continuous series, so any forward-return window that crosses a contract roll is dropped (rolls found as the jumps that coincide with the contract expiry calendar). Everything else in this document stands. GDELT is free and open and must be credited; no GDELT data is committed to the repository. |
| 2026-10-23 | **Deviation D2, logged before the price series was fetched and before any result exists** (the GDELT backfill was running; nothing had been analysed). (a) **Price series**: Yahoo CL=F hourly bars, the longest history Yahoo gives (730 days), stored in `cl_hourly`. 1-minute bars of CL do not exist for that span. (b) **Entry and returns**: entry = the open of the first hourly bar that starts at least 60 seconds after t0; the 60-minute return = that bar close / its open - 1; the 1-day return = close of the last bar starting before entry + 24 h / the entry open - 1. The hourly entry means an event is traded from the next hour, so the study measures drift after the hour of the news, not the instant reaction (conservative; the reaction inside the hour is not tradable with this data). (c) **Unit of analysis**: events in the same entry bar share one return, so they are not independent: the observation is the **entry bar**, and its tone is the mean tone of the events that enter on it. The sufficiency count is the number of distinct entry bars with at least one event inside CL trading hours (gate item 1 now counts bars, still 1,500). (d) **Contract rolls**: an observation is dropped if its entry-to-exit window touches the interval from 1 day before to 2 days after a CL contract expiry (expiry = 3 business days before the 25th calendar day of the month before the delivery month, back one business day if the 25th is not one; US holidays as in `packages/shared/src/clExpiry.ts`). (e) **Tone sources**: the Loughran-McDonald lists could not be fetched (the download link answered quota exceeded) and are free only for academic research, so source 1 is replaced by a crude price-direction word list written for this study (`packages/shared/src/crudeLexicon.ts`, fixed before any result: tone = (bullish - bearish words) / (bullish + bearish + 1)); FinBERT stays a candidate if the owner approves the model download (CC BY-NC-SA, local private use) and is not run otherwise. With one or two sources the family is 2 x 2 = 4 tests; **the trial counter stays at 18**. Holm correction is applied over the tests actually run. (f) The shuffled-tone negative control and a look-ahead shift test are part of the run. Everything else in this document stands. |
