# Divya Drishti: honest assessment before the redesign

Written 2026-10-22, no code changed. Evidence: the code and its tests, the e2e screenshots, the app as it renders today, and what is public
knowledge about the Bloomberg Terminal. Where a statement about Bloomberg is general knowledge and not measured by us, it says so.

## 1. Verdict

We built a **very good data and plumbing layer** and a **feature catalogue on top of it, not a trading tool**. The plumbing (feeds with fallback and
provenance, validation, a cost-honest strategy tester, a server-side paper engine, an MCP interface, native infra) is real and worth keeping. The
interface is 24 panels that each show a dataset, with no model of the trader's day, no hierarchy of what matters, and no view that answers the only
questions a trader has before a trade: *what is the price doing relative to the levels that matter, what is the other market doing, what is about to
happen, how much can I lose, and am I allowed to take this?*

## 2. What exists, how it was verified, what tests cover it

Test inventory today: **462 unit and component tests in 79 files** (shared logic 45 files, web 23, API 5, stream 5, MCP 1), **22 end-to-end checks** in a
real browser, **37 live smoke checks**, **12 source canaries**, **9 recorded-fixture contract tests**. Roughly 14,700 lines of non-test code.

"Verified" has four levels. Most of our work reaches level 1 or 2; very little reaches 3; none reaches 4.

1. Logic is unit-tested. 2. Runs against the live stack (smoke, e2e, canaries). 3. Cross-checked against an independent source. 4. Used by the trader on a real day.

| Area | What exists | Verification reached |
|---|---|---|
| Live prices (Upstox WS, TradingView, Yahoo, USD/INR) | fallback by staleness, drift flag between feeds, bad-quote rejection, session rules, heartbeat | 1, 2. Level 3 only spot checks (5m bars vs TradingView: 90-95% within one tick; USD/INR vs Yahoo). **Tick-to-screen latency has never been measured.** |
| Charts, replay, indicators | third-party chart widget on our data, our indicators checked against its own | 1, 3 (indicators equal to ours; Pine definitions) |
| Quote, watchlist, ticker tape, status bar | provenance badges, stale and closed states | 1, 2 |
| Options chain (compact and detailed) | TradingView greeks merged with Upstox OI and volume; OI change from our own snapshots | 1, 2, 3 (ATM call and IV vs Upstox). The OI-change baseline is days old, so it is mostly "session open", not "yesterday". |
| Futures curve, COT, EIA, JODI, chokepoints, calendar with actuals | free official sources behind a common fetcher contract | 1, 2, 3 for EIA actual and COT parsing against the releases |
| News | about ten RSS feeds, dedupe, tags, archive | 1, 2. **Latency is minutes (polls), not a squawk.** |
| Alerts | browser and server-side, Telegram and webhook | 1, 2 with a fake Telegram. **Never confirmed on your phone.** |
| Costs and position sizing | Upstox cost stack, fixed-risk lots | 1. **Rates never checked against a real contract note; the exchange charge has two published values.** |
| Strategy tester | next-bar fills, costs, shuffle test, walk-forward, plain-language doubts | 1, 2. Honest by design; depth of history is the provider's limit (weeks). |
| Paper trading and MCP | server engine, caps, audit, labels, idempotency, trailing stop, MCP tools | 1, 2, 3 (live throwaway-account runs). Never used for a real trading day. |
| AI briefing and recap | grounding by code, MCP briefings | 1. **Never run against the real model.** |
| Insider trades (SEC Form 4) | parser, panel | 1 only. **Never seen live: no contact configured.** |
| Platform | native Postgres and Redis, retention, cleanup, security defaults | 1, 2 |

Where the test suite is thin: web behaviour (23 test files for about 6,400 lines), API controllers (5 files for about 20 controllers), no visual
regression, no performance or soak test, no latency measurement, no usability test with the trader, no check of prices against exchange settlement data.

## 3. What the Bloomberg Terminal is really for, and what we learned

General knowledge, not measured by us. Reported at a few hundred thousand subscribers and about $25-30k a year per seat.

For a professional it is **not a charting or data screen**. It is:

1. **One agreed set of numbers.** Everyone on the desk sees the same price, curve and analytic; disputes end there. That is authority and provenance.
2. **Breadth in one place** with the same grammar everywhere: a security, a function, then GO. Learning it once works across every asset class.
3. **News and events fast and curated**, with alerts tied to what you hold or follow.
4. **The network**: chat with the counterparty. In many markets this is where trades are actually negotiated.
5. **Execution, positions, risk and compliance** in the same place as the analysis: order routing, an audit trail, limits, who did what.
6. **Workflow glue**: Excel, an API, saved layouts, 24-hour human support.

Why the screen is dense: **consistency, not quantity**. Every panel obeys the same grammar, links to the same security, and drills down to the next
function. Density works because there is a strict system behind it.

What we learned from copying it: we copied its **surface** (dark dense look, a command bar with mnemonics, link groups, F-key workspaces, a panel per
topic) and left out its **substance**: authority and provenance as the product, workflow integration, drill-down, and a single grammar.

## 4. Where we went wrong, and where we crossed the line

1. **Feature-first, never workflow-first.** Every addition answered "what could be shown" ("add insider trades", "add JODI", "add Live TV", "add a heatmap"),
   not "what decision does this serve". There was no written day-in-the-life of the trader, so nothing could be cut. The assistant (me) went along with that
   when it should have pushed back with exactly these questions much earlier.
2. **Reference repos set the scope.** OpenTerminal and similar projects supplied the shopping list. They are general-market terminals; you trade four MCX
   energy contracts and watch NYMEX and USD/INR.
3. **Completeness mistaken for utility.** JODI is monthly with a six-month lag. Chokepoints are days behind. Insider trades are US equities we do not trade.
   The energy heatmap and screener are stocks. Live TV is entertainment. None moves a futures decision at 14:30.
4. **Duplicates.** Two charts, two option chains, a ticker tape beside a watchlist beside a status bar. A professional tool has one of each.
5. **Panels are viewers, not instruments.** You cannot click a number and drill to its history, its source or its related function. Link groups carry only a symbol.
6. **Nothing ties the pieces together at the point of decision.** Costs, sizing, the paper ticket, the journal and the calendar are separate islands; nothing says
   "this trade, this size, this much at risk, this event in 40 minutes".
7. **Verification weighed on logic, not on use.** 462 tests prove the arithmetic; none proves a trader can find the previous day's high in two seconds.
8. **UI craft was an afterthought.** Looking at the app today: the default desk has empty space beside and below the panels; small charts show a phone-style
   toolbar at the bottom; the watchlist cuts a row in half; headers repeat the symbol; the first-run dialog is a wall of 24 mnemonics; type sizes and chrome vary
   panel to panel.

**Where the line was crossed.** Dense-and-professional becomes dense-and-incomprehensible when **density has no hierarchy and the navigation has no grammar**. We
crossed it when the sidebar became a flat list of 24 two-to-four-letter codes of unequal importance, with nothing to say which three matter right now. A
Bloomberg screen is dense but every panel has a reason to be next to the others. Ours are next to each other because we added them.

## 5. Alignment with the real thing

| Bloomberg concept | Ours | Honest status |
|---|---|---|
| Command line with mnemonics and GO | `Ctrl+K` palette, 24 codes | **Looks the same, works differently**: no function grammar, no search by meaning, no drill-down |
| Panels linked by security | four link groups carrying a symbol | partly; no linking by anything else |
| GP / HP price graphs | chart with a third-party toolbar | adequate chart; **no levels, sessions or cross-market overlays** |
| News with alerts | RSS archive with filters | **slow and uncurated**; no squawk |
| Economic calendar | calendar with actuals | good; **not tied to a countdown or an expectation** |
| Forward curves | curve panel | decent |
| Options monitor | chain with greeks and OI change | decent; **no vol surface or skew** |
| Alerts | browser and server | works; **not in the main view** |
| Execution and order management | none (paper only) | known and intended later |
| Positions, risk, P&L | nothing beyond the paper list | **the biggest hole** |
| Messaging, Excel, help desk | none | not relevant to a one-person tool, except **export** |
| Authoritative, audited numbers | provenance badges, drift flag, canaries | **our best idea, kept small** |

## 6. Do the widgets make sense, for this trader

The decision loop of an intraday energy-futures trader: **context** (overnight, levels, events), **price action and the lead market**, **trigger**, **size and
risk**, **manage**, **review**. Judged on that:

| Panel | Supports | Verdict |
|---|---|---|
| Chart | price action | **Core.** Needs levels (prior day high/low/close, VWAP and bands, opening range, session breaks), and a cleaner small-size mode |
| Quote | trigger, risk | **Core, rework** into a depth ladder with time and sales; top-of-book alone is thin |
| Watchlist | monitoring | **Core, rework** into a monitor with cross-market columns (see the gaps) |
| Paper trading | size, manage | **Core, rework** into positions, orders, live P&L, margin and daily risk |
| Costs and size | size, risk | **Merge** into the order ticket and the risk view |
| Calendar and EIA | context, event risk | **Core, merge**: one event timeline with countdown, consensus and actual, reaction history |
| News | context | **Keep, rework**: faster, source-ranked, relevance by instrument |
| Futures curve | context | **Keep**, add spreads and roll yield |
| Option chain | trigger, context | **Keep one**: merge the compact and detailed panels |
| COT | weekly context | **Keep** in a context desk |
| Alerts | all | **Elevate** to always visible |
| Strategy tester, data quality, AI briefing, recap | research, system | **Move** to a research or system desk, off the default |
| JODI, chokepoints | slow context | **Demote**: reference only |
| Simple chart, compact option chain | none | **Cut** (duplicates) |
| Insider trades, energy heatmap, energy screener, Live TV, ticker tape | none for this trader | **Cut or optional** |

## 7. Gaps

**Trading perspective, what a professional would expect before taking a trade**

- **Cross-market basis**: MCX crude against NYMEX CL times USD/INR. We now have both feeds and the rate, and no panel. This is the most India-specific view there is.
- **Levels and sessions**: prior day high, low, close, VWAP with bands, opening range, volume profile, pivots, the MCX evening session against the NYMEX open.
- **Depth and tape**: a ladder and time and sales, not only the best bid and ask.
- **Positions, margin and risk**: exposure across contracts, margin used against Rs 50,000, risk to the stop in rupees and in R, a daily loss limit, the fact that CRUDEOIL
  and CRUDEOILM are the same underlying risk.
- **Event risk**: a countdown strip, "no new entries within N minutes of EIA", reaction statistics for past releases.
- **Spreads and the Brent-WTI relationship**, volatility regime, implied against realised.
- **A real order ticket** with pre-trade checks (size against risk, margin, session, feed health), bracket and OCO.
- **Journal and performance**: setup tags, MAE and MFE, expectancy by setup, costs drag, equity curve.
- **Daily Upstox login**: the token dies at 03:30 IST and needs a manual login. For a tool used daily this is a real operating gap.

**Product perspective**

- No information architecture: no desks by phase of the day, no default that tells a story.
- No design system: type scale, spacing, number alignment, colour semantics for up, down, stale, alert, and a chrome budget are undefined.
- No consistent panel grammar (header, settings, help, link, drill-down), no function-level help.
- No export (CSV or clipboard), no pop-out windows, no hotkeys for the trading actions.
- No performance budget (tick rate, render time), no latency display, no usability testing.

## 8. What to keep

The feed layer and provenance, validation and canaries, the honest strategy tester, the paper engine (labels, idempotency, trailing, audit), the MCP interface,
the cost model (after checking it), options and curve data, native infra, the security defaults, the test discipline. **Roughly the whole backend stays. The
interface is what gets redesigned.**

## 9. How to redevelop it as a serious tool (no code until step 3)

1. **Define the user and the jobs.** A written day in the life, the instruments and sizes, the style and holding time, the strategy rules, the risk rules, the screens
   used today and what annoys you in them. Every panel must name the decision it serves, or it is cut.
2. **Information architecture and design system on paper.** Desks by phase (pre-market, live, review, research, system), at most five or six panels each; a panel
   grammar; a command grammar; a type, spacing, colour and density specification; a cut list. Clickable mock-ups reviewed by you.
3. **Prototype on recorded data.** Replay a real session through the new screens at speed so layout and timing can be judged without a live market.
4. **Build in thin slices, each with acceptance in trader terms** ("find the prior day high in two seconds", "size and place a paper bracket in under ten", "see the next
   release and its countdown from every desk").
5. **A verification ladder that reaches level 4**: logic tests, a data-truth audit against exchange and broker records, visual snapshots, timed task tests with you,
   latency measurement, then a forward paper run on real days before any execution work.

Principles: one screen per decision; no panel without a decision; every number carries its source and age; curated defaults, never a dump; quiet unless
something is actionable; one of each thing.

## 10. What I need from you to start step 1

1. Which contracts you actually trade, with what size on Rs 50,000, and whether CRUDEOILM is the main one.
2. Your style and hold time (scalp, intraday, overnight) and which sessions you trade.
3. The strategy rules you follow now (the "USIB" work), in your words or the other session's notes.
4. Your risk rules: loss per trade, per day, margin comfort.
5. What you use today (TradingView, Upstox Kite, others), what you like in each, and what you cannot stand.
6. Your screen setup: one monitor or several, and the resolution.
7. A real recent trading day, narrated: what you looked at, in what order, what you decided, and what was missing.

## Decisions log (owner)

| date | decision | consequence |
|---|---|---|
| 2026-10-22 | **Remove JODI** (panel, API route, MCP tool, source check). | A removal list is below; nothing has been changed yet because the redesign starts on paper. |
| 2026-10-22 | **Keep Live TV.** It leaves the "cut or optional" group. | It stays in the product; where it lives (its own desk, or an optional panel) is decided in the information architecture. |
| 2026-10-22 | The rest of the "cut or optional" group (insider trades, energy heatmap, energy screener, ticker tape) stays **cut or optional**. | Each is decided at design time: removed, or kept off the default desks. |

### What removing JODI touches (so the removal is one planned change, not a hunt)

- Web: `JodiPanel.tsx`, the `jodi` widget type, its size and registry entries, the `JODI` mnemonic, its styles, the entry in the data-quality panel, two tests that name it.
- API: `jodi.controller.ts`, its entry in the module and in the canary list, a controller test.
- Shared: `jodi.ts` and `jodi.test.ts`, `jodiFetcher` in `fetchers.ts`, its source registry row, its freshness budget, the 18 MB canary sample and the recorded fixture `fixtures/jodi.json`, user-agent and provenance entries.
- MCP: the `get_jodi` tool and its tests (the tool count drops from 23 to 22).
- Checks: the JODI panel test in the browser suite and the JODI check in the smoke test.
- Docs: `CLAUDE.md` and the reference review.
- Saved layouts: a workspace saved with a JODI panel must load without it, not crash, so unknown panel types have to be dropped on load.
- Side benefit: the daily 18 MB JODI download stops.
