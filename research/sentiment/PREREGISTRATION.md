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
