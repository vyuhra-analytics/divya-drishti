# Results: does crude headline sentiment carry information about subsequent crude returns?

Run on 2026-10-23, once, after the data gate passed under deviations D1 to D4 (PREREGISTRATION.md). Events: 79,459 unique crude headlines from GDELT (23 Apr to 23 Oct 2026). Tone: the fixed crude price-direction word list. Instrument: NYMEX CL hourly (Yahoo CL=F), roll windows dropped, the first session after each exchange holiday excluded (D4). Unit: the entry bar (the first hourly bar starting 60 seconds or more after the headline's GDELT time).

## Pre-registered tests (the only ones that can make a claim)

| Horizon | n (entry bars) | IC (Spearman) | p, one-sided | Holm p | Shuffled-tone control | IC, first half / second half |
|---|---|---|---|---|---|---|
| 60 minutes | 2,298 | **-0.0023** | 0.55 | 0.55 | z = -0.54 | +0.021 / -0.028 |
| 1 day | 1,798 | +0.0967 | 0.0002 | 0.0004 | z = 1.69 | +0.079 / +0.103 |

**60 minutes: no information.** The IC is zero to three decimals and the sign flips between halves.

**1 day: nominally significant, and almost certainly not a forward signal.** Three reasons, the first two known before the run and the third found after it:
1. The 1-day returns of adjacent entry bars overlap almost completely, so 1,798 observations are about 120 trading days. The permutation test assumes exchangeable observations and so overstates the significance.
2. A headline reports what is already moving. The 24-hour window starting at the entry bar contains the rest of the same day's move, which the headline's tone reflects.
3. **Exploratory check** (not pre-registered, written after seeing the 1-day result; trial counter 18 to 19): collapse to one observation per trading day. The day's mean tone against the **same day's** return: IC +0.278 (n = 100, p = 0.002). Against the **next** trading day's return: IC +0.022 (n = 99, p = 0.41). Tone tracks the move that is happening and does not predict the next one.

## Verdict

**Inconclusive, leaning to no usable signal.** By the success criteria of the pre-registration a positive verdict needs, all together: Holm p below 0.05 with IC of at least 0.05 (met at 1 day only on the overlap-inflated test), a positive mean P&L after costs with its bootstrap interval above zero, deflated Sharpe probability of at least 0.95, probability of backtest overfitting below 0.20, superior predictive ability against the baseline ladder, the same sign in both halves, a passed positive control, a passed negative control (met), and a second implementation of IC and P&L. The P&L, deflated Sharpe, overfitting probability, baseline ladder, positive control and second implementation were not built or run. So this is **not a positive result**, and the one nominally significant cell has a clear alternative explanation.

## What this does and does not show

- It shows that this word list's tone, on these headlines, has no detectable forward information at 60 minutes, and that the next-day IC is near zero.
- It does not show that no sentiment measure can work: a better labeller (FinBERT, an LLM scored against hand labels) is untested, and hourly bars cannot see reactions inside the hour.
- The headline set is 79,459 titles from one aggregator with a 15-minute clock, filtered by a fixed rule that keeps some off-topic titles (about 10 of 13 kept were real crude news on a sample).
- Contract rolls in a spliced Yahoo series, a six-month window and one instrument.

## Deviations and trials

D1 to D4 are logged in PREREGISTRATION.md before each step, with D4 disclosed as made after seeing the audit. Trial counter: 18, plus 1 for the exploratory daily check = 19.
