# Family accounts: member ledger and broker P&L analysis

Status: PLAN, agreed 2026-10-28, build starts 2026-10-29. No code written yet.

## What the owner decided

1. **Real trades, mostly past ones.** The data is the trading already done in several family accounts, not paper trades. Fees change year to year (an account's 2023 charges are not what 2026 would charge), so every year must be costed with that year's rules, or with the broker's own reported charges.
2. **Brokers: Zerodha and Kotak** (more later). Both can export Excel, so the first input is the broker's own file, not typing.
3. **Own household only.** The app is a record-keeper. No trade ideas, no orders, nothing for people outside the family.
4. **No sensitive identifiers.** No PAN, no full account numbers, no passwords or API keys. A nickname and an optional "last 4" label at most. Some data is hidden behind a switch (see Privacy).
5. **No loss cap yet.** The first job is analysis: upload the P&L of every member's accounts and see realised P&L, charges and taxes, and the net result by year and month. Limits can come after the numbers have been seen.

## First job, in one line

Upload each broker's P&L and tradebook files per member, store the rows once, and answer: how much did each member, each broker and the family make or lose by year and month, how much of it went to charges and taxes, and what is the net.

## Model (small on purpose)

- `family_members`: id, nickname, relation, hidden (bool), note.
- `family_accounts`: id, member, broker (zerodha / kotak / other), label (nickname + optional last 4), kind (trading now, investment later), segment notes, opened/closed dates.
- `family_trades` (the ledger, one row per broker trade or per realised line): account, instrument (symbol, expiry, strike, type), segment (equity delivery, equity intraday, equity F&O, commodity F&O), side, quantity, price, trade time, exchange trade id when the file has one, `source_file_id`, `row_hash`.
- `family_pnl_lines` (realised lines AS THE BROKER REPORTED THEM): account, instrument, buy value, sell value, realised P&L, period, source file. Kept apart from trades because a P&L statement lists realised lines, not fills.
- `family_charges`: account, period, brokerage, exchange charges, STT/CTT, SEBI fee, stamp duty, GST, DP/other, source: `reported` (from the broker's file) or `computed` (from a dated rate table).
- `family_imports`: file name, hash, broker, account, parsed row count, reconciled total, imported at. The file itself is NOT kept by default, only its hash, so a re-upload is detected and importing twice never doubles a number.

## Costing past years (the owner's point 1)

- Where the broker's file states the charges, **use the reported charges**; they are what was actually paid.
- Where only trades are available, compute with a **dated rate table** (rates with `effective_from` dates: STT/CTT, exchange transaction charges, SEBI fee, stamp duty, GST, brokerage by broker plan). The current `costs.ts` table is one point in time and cannot be used for 2023.
- The rate history must be **researched from official sources before it is coded** (SEBI/exchange circulars, the broker's published charge pages and their archives). Nothing from memory goes in as fact. Each rate row records its source and date checked; a year with no source is marked "not verified" and is shown that way.
- Always reconcile: the sum of parsed lines against the file's own totals; a difference is shown, never absorbed.

## Analysis the first screen must give

- Realised P&L, total charges and taxes (broken into brokerage, exchange, STT/CTT, SEBI, stamp, GST), **net P&L**: by **financial year (April to March)** and calendar year, by month, by member, by account/broker, by segment, by instrument.
- Charges as a share of gross profit (the number that shows how much trading costs), best and worst months, loss-making members/accounts highlighted.
- Family total with each member's share.
- F&O turnover (the sum of absolute settled P&L, by the usual method) per member per financial year, because that drives the accountant's questions. Labelled as a helper, **not tax advice**; the segment decides the head of income (commodity derivatives and equity F&O are non-speculative business income, equity intraday is speculative), and the screen shows the split without giving a tax opinion.
- Reconciliation panel: parsed total against the file total, duplicate rows skipped, rows the parser could not read.
- Export: monthly and yearly statement per member (CSV/Excel) for their accountant.

## Layout

A new desk **"Family"** (key to be chosen, F9 is the saved-workspace slot): member and account strip with the privacy switch; year and month P&L table and chart; charges and taxes breakdown; imports list with reconciliation; ledger with search; an import dialog (member, account, broker, file). Reuse the existing table/panel styles and the dark theme.

## Privacy

- Data lives in the local Postgres only; no member data is sent anywhere, and none goes to the Anthropic API or MCP unless a tool is added later and the owner turns it on.
- A **hide switch**: member names become nicknames/initials and amounts can be masked on screen; members marked hidden are excluded until revealed. This is screen privacy, not encryption.
- Original files are not stored; only hashes and parsed rows.
- No PAN, no full account number, no credentials, ever.

## Build order

1. **Day 1.** Tables (migration 027), members and accounts screens, import framework (file, hash, idempotent rows, reconciliation), Zerodha P&L and tradebook parsers against real sample files, the yearly/monthly P&L table with reported charges.
2. **Day 2.** Kotak parsers, charges/taxes breakdown, segment and instrument views, turnover, the dated rate table for trades without reported charges (research first).
3. **Day 3.** Statements export, privacy switch, polish, tests, docs.
4. **Later.** Open positions with live marking, per-member limits, investment accounts (holdings, average cost, dividends, XIRR).

## Needed from the owner tomorrow

- One real file per broker per kind, for the oldest year and the newest year you have: Zerodha Console P&L (Excel) and tradebook, Kotak P&L statement and tradebook. Black out names/PAN/client ids if you wish; the parser needs the columns, not the identity. Formats change between years, so the oldest and newest tell us the range. They become recorded fixtures (anonymised) for the parser tests.
- Which segments each account trades (equity delivery, equity intraday, equity F&O, commodity).
- The members and accounts to create (nickname, relation, broker).
- Which years to cover.
- Whether a P&L file the broker makes already includes charges as a separate sheet (Zerodha's does in some versions); the samples will show.

## Open questions

- Financial year or calendar year as the default view? (Plan: financial year, calendar year one click away.)
- Do any accounts hold equity delivery or mutual funds now? That belongs to the investment phase, but its P&L files may be mixed into the same download.
- Spreadsheet library: Excel parsing needs a dependency (SheetJS or ExcelJS); choose after seeing the samples.
