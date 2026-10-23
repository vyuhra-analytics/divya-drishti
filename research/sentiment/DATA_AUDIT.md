# Data audit (gate B) for the headline sentiment study

Run on 2026-10-22 against the live database, after the pre-registration (`876d857`) was committed. **Result: the data cannot answer the question.
Gate B failed on four of five items, so by the pre-registration no experiment was run and no threshold was relaxed.**

## Gate items

| # | Requirement (from the pre-registration) | Found | Result |
|---|---|---|---|
| 1 | At least 1,500 independent events in the primary cell | 2,207 headlines in total, 1,572 tagged crude or oil, 1,235 of those inside the MCX session (Mon-Fri 09:00-23:30 IST). Headlines cluster: only **123** distinct 15-minute buckets contain one, which is the most independent events there can be. That is 8% of the 1,500 needed. | **FAIL** |
| 2 | At least 60 trading days, at least two volatility terciles | Headlines run from 2026-10-19 07:34 IST to 2026-10-22: 4 calendar days, the first nearly empty (17 headlines), so about 3 trading days. Per day: 17, 217, 1,410, 563. | **FAIL** |
| 3 | Timestamps: first-seen recorded, or publish time validated against an independent clock with median lag 5 minutes or less | The `news` table has no first-seen column. Its `updated_at` moves every time a story is touched by a poll, so it is not a first-seen time (the proxy `updated_at - published_at` has median 89 minutes and is meaningless for this). `published_at` is the feed's own time, which can trail the wire. No independent validation exists yet. Every event is `unverified_time`. | **FAIL** |
| 4 | 1-minute bars present for at least 99% of session minutes, no gaps, rolls accounted for | 1-minute MCX CRUDEOIL bars exist only from 2026-10-14 (7 days). 870 of 870 session minutes on 14, 15, 16, 19 and 21 October, but **390 of 870 (45%) on 20 October**: the hours before 17:00 IST are missing. 22 October is partial (live). **Rolls recorded: 0.** The history is front-month only (provider limit), and between the 19 October close (9455) and the first bar on 20 October (9596 at 17:00) there is a 141-point jump that cannot be told apart from a contract roll. | **FAIL** |
| 5 | A look-ahead test showing that shifting event times changes the returns used | The analysis pipeline does not exist yet, so the test cannot be run. | **NOT RUN** (moot: items 1 to 4 fail) |

## Other findings that matter for the plan

- **Price history depth is the second limit.** Our providers give 1-minute bars for about 7 days, 5-minute for about 30 days, hourly for about 90 days
  (Upstox) and daily for about 2 years. A 60-trading-day study at a 60-minute horizon is possible only on hourly bars, and only with the roll problem solved.
- **Licences.** FinBERT's model card says CC BY-NC-SA 4.0 (checked via the Hugging Face API). CrudeBERT's model card declares **no licence**, and its
  thesis repository (`Captain-1337/Master-Thesis`, last pushed 2021-11-25) has no licence either. With no licence, the default is that all rights are
  reserved: we must not redistribute it and should ask the author before relying on it.
- **Positive control.** The thesis repository contains notebooks (preprocessing, FinBERT fine-tuning, logistic regression, N-BEATS) and no data file that
  I could find at the top level of its folders. The published result cannot be replicated from it as it stands.
- **GDELT as an independent source** (checked, not yet used): its 2026-10-22 files exist and downloads work. One 15-minute GKG file (06:00 UTC) had
  877 rows, **every row with a page title** (`PAGE_TITLE`), a 15-minute timestamp, the source domain and themes; about 42 of the 877 matched an oil theme
  or phrase, and some of those were not oil headlines, so a relevance filter is needed. Older files exist (a 2023 file answered 200). The timestamp is
  GDELT's processing time, in 15-minute batches: that is a conservative first-seen clock, but it makes a 15-minute horizon meaningless.

## Verdict (gate D)

**No result.** The question "does headline sentiment carry information about crude returns net of costs" **cannot be answered with the data we have**: roughly
8% of the independent events needed, 5% of the trading days, no verified clock, a gap and an unrecorded roll in the price series. The experiments were not
run. This is a statement about the data, not about FinBERT or CrudeBERT, and it is not evidence for or against sentiment.

## Acquisition plan (what would make the study answerable)

1. **Start the clock today: record first-seen.** Add `first_seen_at` to the `news` table, set once on first insert and never updated. Until that
   exists every future event is also `unverified_time`. Our own capture produces about 41 in-session independent events a day (123 buckets in 3 days),
   so the 1,500-event gate needs about 37 trading days and the 60-day gate needs about 12 weeks: **roughly mid-January 2027.** The IC 0.05 sample (5,870)
   needs about 5 months.
2. **Backfill from GDELT** (free, timestamped, with titles): stream each 15-minute GKG file, keep only rows that match a crude-oil title or theme filter,
   deduplicate. One file is about 3.7 MB, so a year is about 125 GB of downloads if every file is fetched; the streaming filter keeps only the oil rows.
   Resolution is 15 minutes, so the study would use horizons of 60 minutes and 1 day only.
3. **Change the primary cell, and log it before any analysis.** MCX history is too short. Run the information test on NYMEX CL (Yahoo hourly, about 2 years)
   and treat MCX only as the tradable translation (costs, lot size) for the forward paper test. This is a deviation from the pre-registration, so it must
   be entered in its log with the reason, before any result exists.
4. **Roll handling:** build the contract calendar and drop any forward-return window that crosses a roll, instead of trusting a spliced series.
5. **Positive control:** obtain the CrudeBERT thesis dataset from its author, or use a published result that is reproducible on free data (time-series momentum
   on crude, Moskowitz, Ooi and Pedersen 2012) to validate the price and backtest side of the pipeline.
6. **Licences:** ask the CrudeBERT author in writing. If there is no answer, use FinBERT locally for private research only, plus the word-list baseline,
   or train our own classifier on the collected headlines.
7. **Build the remaining pipeline** (look-ahead test, second implementation of IC and P&L, controls) before the data is ready, so the day it is ready
   the pre-registered experiments run once.

## Status of the acquisition plan

| date | step | status |
|---|---|---|
| 2026-10-22 | 1. Record first-seen | **Done.** `news.first_seen_at` (migration 011), set once on insert, never overwritten. Checked live: a story first seen at 13:02:54 was touched again at 13:09:06 (`updated_at` moved) and kept its `first_seen_at`; 24 stories carried it within minutes, none had it later than `updated_at`. Older rows stay NULL. The 1,500-event gate is now expected about 37 trading days after 2026-10-22. |
| 2026-10-23 | 2. GDELT backfill | **Started.** Deviation D1 logged first (`842d0db`). `packages/shared/src/gdelt.ts` (zip reader, GKG parser, the fixed relevance rule, normalised-title dedup; 8 tests), migration 016 (`gdelt_headlines`, `gdelt_batches`), `bun run gdelt:backfill -- --from= --to=` (resumable, 8 downloads at a time, about 58 batches a minute). One day (2026-06-01) read in under two minutes: 96 batches, 724 headlines kept before dedup, 491 unique; precision on four sample files was about 10 of 13 real crude-market headlines (the rest: barrel racing, a national fuel-price notice). The rule is fixed: tightening it later adds a trial. Six months (2026-04-23 to 2026-10-23, 17,472 batches, about 40 GB of downloads, about 5 hours) running. |
| 2026-10-23 | 3. Primary cell change (log first) | **Logged** as D1 in PREREGISTRATION.md before any GDELT data was fetched. |
| 2026-10-23 | 4. Roll handling | **Built** (`clExpiry.ts`: CL expiry calendar with US holidays; an observation whose entry-to-exit window touches 1 day before to 3 days after an expiry is dropped; known expiries tested: Dec 2025 on 20 Nov 2025, Jan 2026 on 19 Dec 2025, Dec 2026 on 20 Nov 2026). Not yet checked against the jumps in the data. |
| | 5. Positive control data | not started |
| | 6. CrudeBERT licence enquiry | not started |
| 2026-10-23 | 7. Remaining pipeline | **Partly built**: CL hourly history in `cl_hourly` (13,559 bars, Yahoo, 730 days), fixed crude lexicon, observation builder, Spearman IC with a seeded permutation test, Holm, shuffled-tone control, look-ahead test, and `research/sentiment/run-study.ts` (audit by default; experiments only with `--run` and every gate passing). 37 tests, 10 mutation checks caught. Not built: P&L after costs, deflated Sharpe, overfitting probability, baseline ladder, second implementation, positive control, FinBERT. Deviations D2 and D3 logged in PREREGISTRATION.md before any result. |

Backfill progress on 2026-10-23: about 700 of 17,568 batches read; the data gate cannot be run on the full range until it finishes. Known risk: the hourly-coverage gate (item 4) read 125 of 127 trading weekdays with 20+ bars (98.4%) on the partial run, below the 99% written in D3, because two sessions after exchange holidays have 19 bars; if it still fails on the full run, relaxing it needs its own logged deviation (D4) and is a disclosed change made after seeing the number.

## Re-run on 2026-10-23 (owner asked to use the news data for the study)

Same queries against the live database, same gate. **Nothing changed in the verdict; the experiments were not run.**

| Gate item | Found 2026-10-23 | Result |
|---|---|---|
| 1. at least 1,500 independent events | 3,900 headlines, 2,835 tagged crude or oil, 2,367 of those inside the MCX session; **175** distinct 15-minute buckets contain one (12% of 1,500) | **FAIL** |
| 2. at least 60 trading days | headlines on 5 calendar days (19 to 23 Oct), about 4.5 trading days | **FAIL** |
| 3. verified timestamps | `first_seen_at` is recorded for 1,112 of the in-session events, in **52** independent buckets; the rest are `unverified_time` and cannot carry a claim | **FAIL** (grows by about 25 verified buckets a day) |
| 4. price bars | `bars_1m` for MCX crude holds 802 minutes on 22 Oct and 548 on 21 Oct (of 870 in a session), the 20 Oct day almost nothing: the stream-built minute bars are not complete enough, and the provider history is front-month only with no roll recorded | **FAIL** |
| 5. look-ahead test | pipeline not built | **NOT RUN** |

At about 41 independent in-session events a day the 1,500 gate is still about 33 trading days away on the first-seen clock, mid-December 2026 at the earliest, and the 60-trading-day gate about 12 weeks. A result meeting IC 0.05 needs about five months.

