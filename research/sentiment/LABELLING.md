# Labelling rubric for crude headlines

Written 2026-10-23, before any label was made. One rubric for every labeler (you, Claude, a model prompt), so the labels can be compared.

## What you label

**What the headline implies for the price of crude oil**, as a trader reading it cold. Not the tone of the writing, and never what the price did afterwards. The page shows only the headline and the outlet, no date, no price, no model score.

| Label | Key | Meaning | Examples |
|---|---|---|---|
| **Bullish** | 1 | implies higher crude prices | supply loss or risk (attacks, outages, sanctions, Hormuz), production or output cuts, inventory draws, stronger demand, "oil jumps as ..." |
| **Bearish** | 2 | implies lower crude prices | oversupply, output increases, inventory builds, weak demand, ceasefire or peace deals, recession fears, "oil slides as ..." |
| **Neutral** | 3 | about crude, but no clear direction | meetings, speeches, schedules, mixed or unsurprising statistics, "oil steady" |
| **Not crude** | 4 | not about the crude price | other oils (palm, olive, motor), a company's stock rating, natural gas only, local pump-price notices, off topic |

## The extra flag

**M, "reports a move that already happened":** the headline only reports that the price moved, with or without a reason ("Oil jumps 3%", "Brent falls to $90"). Such headlines describe the past, so their tone matches the same hour's return and cannot predict the next one. Press **M** before the label key to flag it (the label is still the direction reported). The study can then be run with and without these.

## Rules of thumb

1. Label the implication for crude, even when the writing is negative: "tankers attacked" is bullish.
2. A headline with two opposite signals and no clear winner is neutral.
3. If you cannot tell whether it is about crude at all, it is not crude.
4. Do not guess what happened next. If you remember the price move, ignore it.
5. When unsure between a direction and neutral, choose neutral.

## How the labels are used

Each candidate labeler (the crude word list, FinBERT, an LLM prompt) is scored against the gold labels: accuracy, per-class errors, Cohen's kappa. A labeler that does not clearly beat the word list is not worth using. Labels are never derived from prices and are never used to train on returns. Any tone source added to the sentiment study is an extra trial in its correction (PREREGISTRATION.md).
