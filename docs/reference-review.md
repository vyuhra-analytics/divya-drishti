# Reference review: seven repositories against Divya Drishti

Review date: 2026-10-21 (OpenBB section updated after the full clone). Nothing in this document is implemented yet; it is the list to go through together before we adopt anything.

**Your decisions (answers to section 13):** OpenBB re-cloned and read in full; do **both** the AI-trust block and the free-data block; Telegram for alert delivery (you create the bot); you **do** want a backtester and paper trading, so R19 and R20 are in scope and R18 grows from a calculator into the cost engine they depend on; and **research-only for now, with real-time broker execution as a later phase** that starts only after the relevant features have been verified, tested and used by real users (the gate is spelled out in section 11, R21).

## 0. How this was done, and its limits

I read each repository's README, the architecture and concept docs, and the source of the modules that matter to us (listed under each repo). I ran none of them, so claims about behaviour come from code and docs, not from using the software. Where something is a README claim I could not check, I say so.

- **OpenBB (`D:\OpenBB`) was re-cloned and is now read from disk** (4,138 files, latest commit 2026-10-18, Apache-2.0 per its `LICENSE`). The first review used GitHub pages only because the original clone was broken; section 3 is rewritten from the source.
- Four things I verified myself against the live internet, because they change recommendations: the EIA weekly petroleum and natural-gas storage CSV files are free and need no key; the CFTC positioning (COT) API answers without a key; the IMF PortWatch API returns daily Strait of Hormuz transit counts without a key; the JODI oil-statistics archive downloads without a key (details in section 3.3).
- Our own facts used for comparison are from this repository today (121 tests passing, typecheck green).
- Licences matter for what we may copy. Section 12 lists them. Short version: MIT and Apache-2.0 code can be reused with the notice; **NautilusTrader is LGPL-3.0, so we take ideas only, never code.**

## 1. Executive summary

| # | Repository | What it really is | Value to us | Take |
|---|---|---|---|---|
| 1 | `forex-trading-ai-agent` (K.I.T.) | A hype-heavy autonomous-agent bot (Node/TypeScript) with 150 "skills" | Low | One idea: an autonomy ladder with hard guard-rails. Its own test report shows about 22% of its features working |
| 2 | `nautilus_trader` | A production-grade Rust and Python trading engine (backtest = live) | High for ideas, none for code | Continuous-futures roll adjustment, bar-timestamp and data-integrity rules, fixed-risk sizing, crash-only recovery posture |
| 3 | `OpenBB` | A data-platform framework (providers, REST, MCP, Workspace UI) | High | The provider "fetcher" pattern, the MCP server design, and free EIA and CFTC data sources |
| 4 | `openterminal` | The terminal we first benchmarked against | Low (already covered) | A few hardening details we are missing (user-agent pool, bounded caches, concurrency limiter) |
| 5 | `OpenTerminalUI` | The most complete terminal-plus-AI-analyst we have seen (Python and React) | Very high | A deterministic grounding checker for AI text, provenance on every data point, server-side alerts with delivery, commodity term structure |
| 6 | `tensortrade` | A reinforcement-learning research framework, last commit Feb 2026 | Low | Honest cost lessons, stochastic price generators, composable data feeds |
| 7 | `Vibe-Trading` | An actively developed AI research and backtest platform (Python, MIT) | Very high for engineering practice | Prompt-injection scanner, run manifests and tamper-evident ledger, model-spend limits, source-health canaries, validation methods, live-trading mandate design |

**The five adoptions I would put first** (all fit our research-only terminal and fix real gaps):

1. **Grounding checker for the AI briefing** (from OpenTerminalUI): every number and every statement the model writes is re-checked in code against the facts we gave it, and flagged verified, contradicted or unsourced. This turns "the model cites evidence" into "we prove it".
2. **EIA actuals and a CFTC positioning panel** (from OpenBB's providers, both free and verified): the calendar then shows released inventory numbers next to the forecast, and you get speculator net positioning for WTI and Henry Hub.
3. **Continuous futures with roll adjustment** (from NautilusTrader): fixes the known gap that daily charts cover one contract's life, and makes indicators correct across rolls.
4. **Server-side alerts with Telegram/webhook delivery** (from OpenTerminalUI and K.I.T.): alerts keep working when the browser is closed.
5. **An MCP server for Divya Drishti** (from OpenBB, with Vibe-Trading and OpenTerminalUI as cross-checks): Claude and other agents can read our quotes, calendar, options and briefings through one read-only, authenticated interface.

## 2. Our baseline, so "better than us" is honest

What we have that these projects mostly do not: a **push architecture** (stream service, WebSocket topics, heartbeats and a stale-feed watchdog) instead of REST polling; **provider fallback with staleness rules** (Upstox, then TradingView, then Yahoo) and a user switch for it; **candles bucketed in exchange time**; **MCX-specific** sessions, holidays, front-month volume roll, options chain with greeks; the energy-only focus; **security defaults** (localhost binding, origin checks, rate limits); an AI briefing whose figures are computed in code; a graded briefing journal; and a small codebase with 121 passing tests.

What we lack, and the repos show: verification of AI output, provenance and conflict detection across sources, spend accounting, server-side alerts, a quant toolkit (costs, sizing, validation), scheduled data-source health checks, an agent-facing interface (MCP), and some free energy datasets.

---

## 3. OpenBB (`OpenBB-finance/OpenBB`, Apache-2.0, full source read)

**What it is.** The Open Data Platform: a Python core (`openbb_core`, about 50,000 lines excluding tests, 740 test files) that discovers *provider* and *router* extensions through Python entry points and exposes every command four ways: a Python API (`obb`), a FastAPI REST server, an MCP server, and the hosted OpenBB Workspace UI. This snapshot ships 17 providers (`bls, cboe, cftc, deribit, ecb, eia, famafrench, federal_reserve, finra, fred, government_us, imf, jodi, nasdaq, oecd, sec, tmx`) and 15 router extensions (`commodity, crypto, currency, derivatives, econometrics, economy, equity, etf, fixedincome, index, mcp_server, news, platform_api, quantitative, technical`). 181 standard data models define one vocabulary for all of them.

**What I looked at.** `core/provider/abstract/` (Fetcher, Data, QueryParams, Provider), `query_executor.py`, `registry*.py`, `command_runner.py`, `app/router.py`; the standard models; the CFTC, EIA, JODI and IMF providers in detail; the commodity and derivatives routers; the `technical`, `quantitative` and `econometrics` extensions; the MCP server (`discovery.py`, `pipeline.py`, `artifacts.py`, `auth.py`); and how providers are tested.

### 3.1 The provider architecture (approach worth copying)
- **Provider** = a small object: `name`, `description`, `website`, `credentials` (names only, prefixed with the provider name), `fetcher_dict` (model name to Fetcher), and `instructions` (for example "register a free key here"). It is the extension entry point.
- **Fetcher[Query, Result]** = three steps, `transform_query` (user parameters to provider parameters), `extract_data` (the only step that sees credentials), `transform_data` (raw rows to a standard `Data` model). A `require_credentials` flag declares whether a key is needed. `fetch_data` runs the pipeline. **`Fetcher.test()` runs the whole pipeline and asserts** the query type and values, that the raw data is non-empty and not already transformed, and that the output has the expected fields and types.
- **QueryExecutor** resolves the provider and fetcher by name and **filters credentials**: a missing one raises "Missing credential 'x'. Check {website} to get it", so the error tells the user exactly what to do. Credentials are `SecretStr` end to end.
- **Standard models** (181) define the shared fields for each data type, such as `EconomicCalendar` (`date, country, category, event, importance, source, currency, unit, consensus, previous, revised, actual`), `CommoditySpotPrices` (`date, symbol, commodity, price, unit`) and `COT`. Provider models extend them with extra fields. A route picks the provider with one parameter.
- **Tests:** unit tests of each fetcher are decorated `@pytest.mark.record_http`, which **records real HTTP responses once and replays them offline**, then call `fetcher.test(params, credentials)`. Separate `integration` tests exercise the REST and Python surfaces.

**Ours today:** each source in `drishti-core-stream` and the API has its own shape; parsers are tested with hand-written fixtures; a missing key gives a custom message per controller.
**Better?** Yes, as architecture. **Take (R13, R36):** a small TypeScript `Fetcher` interface (`transformQuery`, `extract`, `transform`, `test`) with the credential-hint error; standard models for quote, bar, news item, calendar event (add `actual` and `revised`), inventory report, positioning row; and an HTTP record-and-replay helper for provider tests so parsers are checked against real responses that we can refresh.

### 3.2 The MCP server (approach worth copying)
- Every REST command becomes a tool automatically (name from the path; `mcp_config` on a route can rename, hide, exclude arguments or attach prompts).
- **Tool discovery** (`discovery.py`): with discovery on, the route tools are hidden behind synthetic `search_tools` (BM25 over names and descriptions, five results) and `call_tool`, plus `available_categories` and `available_tools`. The agent starts with a short list and pulls tools on demand.
- **`run_pipeline`** (`pipeline.py`): run tools in sequence **on the server**, feeding the results of earlier steps into later steps, so large data (a price history) never passes through the conversation. Their example: fetch prices, then call RSI on them.
- **Artifacts:** Plotly figures in results are converted to chart or table artifacts the client can render.
- Auth: bearer token (Base64 `username:password`) for HTTP and SSE, upstream credentials for the backend, a pluggable auth provider; stdio needs none. Transports: streamable HTTP, SSE, stdio. The system prompt is a resource the agent should read first.

**Take (R23):** an MCP server over our existing API. With roughly 15 tools we do not need discovery now, but we keep the **read-only**, **bearer-auth**, **system-prompt-as-resource** and **server-side pipeline** ideas, and name tools by what they return (`quote_get`, `calendar_upcoming`, `options_chain`, `briefing_latest`).

### 3.3 Free energy data and where it comes from (verified by me today)
| Dataset | Source | Key | Verified | What it adds |
|---|---|---|---|---|
| EIA weekly petroleum status, table 1 and the full `psw09.xls` workbook | `ir.eia.gov/wpsr/` (redirects to a signed URL) | none | Table 1 returned crude stocks 698.560 against 707.117, change -8.557, which equals our calendar's "previous -8.6M" | The **released actual** next to the forecast |
| EIA weekly natural-gas storage | `ir.eia.gov/ngs/wngsr.csv` | none | Header "Released: October 15, 2026 at 10:30 a.m. (eastern time)" | Same for the gas report |
| EIA API v2 datasets (OpenBB generates hundreds of fetchers: `weekly_stocks`, `weekly_supply_estimates`, `weekly_imports_exports`, `refinery_utilization_and_capacity`, `product_supplied`, `nymex_futures_prices`, `spot_prices`, weekly working gas in underground storage, STEO, and more) | `api.eia.gov/v2` | **free key** (`EIA_API_KEY`) | Not called | Deeper history: stocks by product and PADD, refinery runs, demand proxy, spot and futures history. Paginates 5,000 rows per call |
| CFTC Commitments of Traders | `publicreporting.cftc.gov/resource/{dataset}.json` (Socrata) | none (token optional, higher limit) | HTTP 200, JSON | Managed-money long and short, open interest, weekly changes, trader counts, concentration, for WTI and Henry Hub |
| IMF PortWatch maritime chokepoints | ArcGIS FeatureServer `Daily_Chokepoints_Data` | none | Strait of Hormuz, newest rows: 2026-10-18 **2 tankers of 4 vessels**, 10-17 zero, 10-16 one tanker of seven | **Daily tanker transits** through Hormuz, Bab el-Mandeb, Suez, Malacca. Directly relevant to the headlines already in our feed |
| JODI oil and gas statistics | `jodidata.org` zip archive (about 23.5 MB) | none | Download returned HTTP 200 | Monthly production, demand, imports, exports and stocks by country, **including India**; gas balances too |

**Caveats:** the EIA and JODI files are workbooks and archives maintained for people; layout changes would break a parser, so these need record-and-replay tests and the canary checks in R14. PortWatch is an IMF research dataset with its own lag (the newest row was three days old). Terms of use for each dataset still apply.

### 3.4 Analytics toolkits worth knowing about (Apache-2.0)
- **`technical`:** about 50 indicators and signals beyond ours: oscillators (RSI, stochastic, CCI, Williams %R, MFI, TRIX, awesome), overlays (SMA, EMA, HMA, WMA, ZLMA, TEMA, DEMA, KAMA, FRAMA, VWMA, Bollinger, Donchian, Keltner, Ichimoku, SuperTrend), trend (MACD, ADX, DI, Aroon, choppiness), volatility (ATR, **realized volatility and volatility cones**), volume (OBV, A/D, VWAP), structure (Fibonacci, DeMark, pivot points), statistics (**Hurst exponent**, stationarity tests ADF and KPSS, autocorrelation, drawdown and return statistics) and signal classifiers (breakouts, crossovers, divergences, candlestick patterns, a regime classifier).
- **`quantitative`:** normality, CAPM, unit-root tests, Sharpe, Sortino, Omega, rolling statistics, factor models, performance and risk attribution.
- **`econometrics`:** regression, panel and time-series diagnostics.

**For us:** realized volatility, ATR, Hurst (is gas mean-reverting or trending?), a regime flag and drawdown statistics are cheap, pure functions that make the **AI briefing's fact set richer and fully computed**. They are also the building blocks for the strategy tester you now want (R19). We port only what we use, with attribution.

### 3.5 What is not for us
Equities, crypto, fixed income, fundamentals and the Workspace UI. OpenBB is a platform for people who want everything; the value to us is the *patterns* (3.1, 3.2), the *tests* (3.1), and the *public datasets* (3.3). We should not embed OpenBB (a Python service beside our Bun services would double the operations surface).

---

## 4. OpenTerminalUI (`Hitheshkaranth/OpenTerminalUI`, MIT)

**What it is.** A self-hosted research terminal: FastAPI backend with 80+ route modules and about 88,000 lines of Python, a React 18 frontend with 77 pages, SQLite or Postgres plus Redis. README claims 1,400+ backend tests and about 600 frontend tests (not verified by me). Equity and F&O centred (NSE, BSE, US), with a commodities page, crypto and forex.

**What I looked at.** README and architecture diagrams; `backend/agent/` (grounding, claim checks, repair, reconcile, reflections, memory, orchestrator, tool registry); `backend/alerts/` (service, actions, delivery); `services/commodity_service.py` and `fno/futures_analytics.py`; `data_quality/`; `mcp/`; frontend layout.

### 4.1 Grounding: the single best idea in all seven repos
`agent/grounding.py` records every tool result as a numbered **source** (tool, arguments, provider, data quality, as-of time) and, after the model answers, pairs each figure in the text with the source value it came from: **verified**, **mismatch**, or **unsourced**. `claim_checks.py` goes further and re-derives the *statements*: "price is above its 50-day EMA", "cheaper than X on P/E", "down 0.39% on the day" (the direction, not just the magnitude), "near its 52-week high". Each is marked **verified**, **contradicted** or **unverifiable**. The README states the rule: **no LLM judges the LLM; every check is a regex plus a comparison.**
`repair.py` then makes one targeted revision call listing each contradiction and keeps the revision only if it is measurably better (fewer contradictions, no new mismatches, no correct figures lost). Unsourced figures never trigger a repair, because they are often the model's own arithmetic. `reconcile.py` flags when the *sources themselves* disagree (their live example: one store said ROE 18, Yahoo said 148.75) and when a source is staler than a per-kind freshness budget.

**Ours today:** the briefing prompt demands evidence and computes all numbers in code, but nothing verifies the model's text. A model can quote `rsi14 71` and write "RSI is 68", and we would show it.
**Better?** Yes, clearly. **Take (R1, R2, R6):** port the idea (not the Python) to TypeScript: a ledger of the context facts we send, a number-and-statement checker for `bull`, `bear`, `summary`, and a badge per point in the panel (verified, mismatch, unsourced). Our fact set is small and fully computed, so a checker is much easier for us than for them.

### 4.2 Provenance on every data point
Each quote carries `live / delayed / cached / synthetic`, blank metrics say why they are blank, and a unified fetcher walks L1 SQLite, L2 Redis, primary provider, fallback provider while recording the serving source. A data-quality console shows provider status.
**Ours today:** we show source and delay badges and STALE/CLOSED, which is good, but the provenance is not attached to the data object and not carried into the AI context or alerts.
**Take (R2):** a `provenance` field (`source`, `quality`, `asOf`) on quotes, calendar events and every context fact; reconcile Upstox against TradingView when both are live and flag a gap larger than N ticks; freshness budgets per kind.

### 4.3 Alerts engine with delivery and actions
Multi-condition rules (including price crossing a drawn line), a service that evaluates server-side, and delivery to in-app, email, Slack, Telegram, Discord or a webhook, plus actions on trigger (paper order, watchlist add, webhook), capped at five actions per alert and validated.
**Ours today:** alerts are evaluated in the browser only and stop when the tab closes.
**Better?** Yes for reliability. **Take (R22):** move evaluation into the stream service (it already holds every quote and the news feed) and add Telegram and webhook delivery. Keep our alert types; add "price crosses a drawing" later if the advanced chart exposes its drawings.

### 4.4 Commodity term structure and seasonality
`commodity_service.py` builds a futures chain from a contract schedule (next six contract months, fetched per contract from Yahoo or FMP), computes the curve and basis, and builds seasonality from monthly closes. A "linked companies" view shows who gains or loses when crude moves.
**Ours today:** we show only the front month (and an options chain). **Take (R12):** a curve panel. For MCX we already have the full contract list from Upstox's instrument master and can quote every listed month; for NYMEX, Yahoo contract tickers. Show calendar spreads (front minus next), contango or backwardation, and a seasonality strip. This is the most trader-relevant panel we are missing.

### 4.5 Smaller items worth noting
- **Tool registry and model router:** tasks are classified and routed to a model chain (`model_router.py`). Matches our plan for a cheap model for routine summaries and a stronger one for synthesis (R7).
- **Reflections and memory:** closed journal trades produce a short "what this trade teaches" note that feeds later runs (`reflections.py`, `memory.py`). Pairs with our graded briefing journal (R8).
- **Kill switches, OMS audit trail, restricted lists, ops dashboard:** relevant only if we ever execute orders (R21).
- **Plugin system and OpenScript custom indicators:** we get similar reach through the OpenAlgo chart's indicator registry.
- **Filings Intelligence (RAG over 10-K/10-Q with quote verification):** impressive but equity-focused. For us the narrow version is SEC filings of the six energy majors we already track for insider trades. Defer.

### 4.6 What we do better
Real-time push and heartbeat architecture (theirs is REST plus a WebSocket for quotes); exchange-time candle bucketing; MCX sessions, options greeks and front-month roll; the focus (they spread over 100+ pages); a much smaller attack surface.
**Their weak spots:** breadth over depth (an energy trader needs maybe 10% of it), Python plus Node plus Redis plus a database to run, and equity assumptions throughout.

---

## 5. Vibe-Trading (`HKUDS/Vibe-Trading`, MIT)

**What it is.** A very active (multiple commits per day, 3,000+ tracked files) Python platform: a ReAct agent with 113 tools, 90 skills, 30 multi-agent "swarm" presets, 10 backtest engines, 29 data loaders, a hash-chained governance ledger, a "Shadow Account" that learns your trading rules from your broker journal, a live-trading channel behind a safety "mandate", and an MCP server (82 tools). React 19 UI, Docker, nine languages.

**What I looked at.** README (news, features, data sources, API security defaults, live-runner spending, TAP mode), `agent/src/governance/`, `agent/src/live/mandate/`, `agent/src/security/scanner.py`, `agent/evals/harness/`, `agent/backtest/validation.py`, `run_card.py`, `loader_health.py`, `engines/india_equity.py` and `futures_base.py`, `preflight.py`, the commodity skill and swarm preset, `agent/loop.py`.

### 5.1 Prompt-injection scanner (R3): take immediately
`security/scanner.py` scans external text (web pages, search results) with rules (for example "ignore/disregard/override ... instructions") and attaches warning metadata to the tool envelope without rewriting or dropping the content, so downstream agents treat it as untrusted. **We feed internet headlines to the model**; our system prompt says "headlines are untrusted", but nothing detects an injection attempt. A scanner that flags suspicious headlines (and drops them from the context when severe) is a small, high-value hardening.

### 5.2 Run manifests and a tamper-evident ledger (R4)
`governance/manifest.py` fingerprints "what produced this run": system-prompt hash, injected-skill content hashes, tool list, key package versions, into one deterministic hash (timestamp and run id excluded, so two runs under the same method hash the same and a diff names exactly what changed). `governance/ledger.py` is an fsynced, append-only, **hash-chained** JSONL ledger: editing or deleting any record breaks every later hash.
**Ours today:** the briefing journal stores model and result only.
**Take:** add `{model, promptHash, contextHash, appVersion}` to each journal entry (cheap), so we can later answer "did the prompt change between these two briefings", and chain the journal entries by hash so a graded history can be trusted. Their ledger design is MIT and about 200 lines; reusable as a pattern.

### 5.3 Model-spend controls (R7)
The live runner has a decision cadence (default every 15 minutes), a daily cap on decisions and reported tokens, an optional dollar cap computed from configured per-million prices, persisted spending history that survives restarts, and a rule that an unfinished decision after a crash is blocked, never counted as free. Usage is shown in the UI ("View LLM usage in Run Detail"). Limits are checked after each response, so overshoot is possible, and they say so.
**Ours today:** 20 calls per hour and a 5-minute cache; no token or cost accounting, nothing shown to the user.
**Take:** record `usage` from each response (we already receive it), persist a daily total, show "today: N briefings, ~US$X" in the panel, and add a configurable daily cap. This also supplies the data to choose between `claude-opus-5-5` and a cheaper model.

### 5.4 Source health canaries and startup preflight (R14)
`loader_health.py` is a scheduled, isolated lane that probes every public data source with a known symbol, reports outages and **data drift**, and never treats "no connectivity" as a pass; each row carries the loader's own warnings as evidence so an empty result says whether the source refused us or our loader is broken. `preflight.py` prints a status table at startup with the impact of each failure and which failures are critical.
**Ours today:** `/health` plus the Settings feed panel show provider ok/failed counts. We do not probe sources on a schedule or compare their data to a known value.
**Take:** a canary job (every N minutes) that checks each source against an expectation (e.g. TradingView and Upstox crude within X ticks; EIA CSV still parses to a plausible number; RSS feeds still return items) and a startup table in the console. This is also where OpenBB's `Fetcher.test()` fits.

### 5.5 Validation methods for strategy testing (R19, now in scope)
`backtest/validation.py`: a Monte Carlo **permutation test** (shuffle trade order: is the Sharpe better than random?), a **bootstrap confidence interval** on Sharpe, and **walk-forward** analysis, all with a fixed seed and one shared annualisation factor so the figures agree. Their news log shows how often such tools needed correctness fixes (first-bar P&L, annualisation, drawdown duration), which is the real lesson: backtest code is easy to get subtly wrong.

### 5.6 The live-trading mandate (R21, Phase 2 design reference)
A frozen, load-once-at-boot "mandate": hard caps (account funding, max order notional, total exposure, leverage, instrument whitelist with empty meaning deny-all, max trades per day), a discovery universe, consent provenance. **There is no agent-reachable write path to it.** Broker credentials can be isolated behind TAP, a proxy where the agent never holds the key and writes block on human approval. A hash-chained audit ledger records every live action.
**For us:** we are research-only now. Broker execution is a later phase that starts only after the verification gate in section 11. When we get there, this is the design to copy, including "fail closed" defaults, and the order code must not exist before the design is reviewed.

### 5.7 Smaller items
- **Run cards:** every backtest gets a card with hashed execution records and metric-to-CSV references (a trust layer). Same idea as 5.2.
- **Evals harness (`agent/evals/harness`):** a deterministic, read-only verifier that checks a finished run from its files (request, trace, grounding evidence, usage, manifest) and returns PASS, FAIL, NOT_EVALUABLE or INVALID_ARTIFACT per assertion. **Take (R5):** a small set of briefing cases (fixed context, expected facts) that run in CI and fail if the checker, prompt or schema regresses.
- **Data-source chains ordered by IP-ban risk** (never-banned public sources first, throttled ones last, premium ones explicit-only): matches our Upstox, TradingView, Yahoo order, but the "explicit-only, never in auto fallback" label for sources that would give a misleading series is a good rule (R15).
- **India:** a read-only `india_broker` loader (Zerodha, Shoonya, Dhan) and an India **equity** engine with a full delivery cost stack (STT, exchange charges, SEBI fee, stamp duty, GST) written as configurable rates with a warning to verify against the current schedule. **It has no MCX commodity-futures engine**, so for us it is a template, not a solution (see R18).
- **Skills and swarms:** the `commodity-analysis` skill and `commodity_research_team` preset (supply analyst, demand analyst, cycle strategist in a DAG) are prompt-only. They tell the model to fetch data with a generic URL reader, so figures are not grounded. Useful as a **checklist of what an energy briefing should cover** (inventories, OPEC compliance, rig counts, SPR, seasonality, cost curve, geopolitics), not as a design to copy. Pair that checklist with our grounded data.
- **Context compaction (5 layers), read/write tool batching, memory, skill CRUD, IM channels (Telegram, Slack, Discord and ten more), Pixel Office UI, PDF reports, Alpha Zoo (478 alphas):** impressive, mostly out of scope. The scheduled-research idea (a briefing delivered at a set time to a chat channel) is a natural later feature on top of server-side alerts.

### 5.8 Cautions
Scope is enormous (the maintainers fix "nine financial correctness bugs" in a day), the surface for supply-chain and credential risk is large (they scrub secrets and added TAP for a reason), and the broker-write capability is a liability for our purposes. Treat it as a source of practices, not a dependency.

---

## 6. NautilusTrader (`nautechsystems/nautilus_trader`, LGPL-3.0: ideas only)

**What it is.** A Rust-native engine with a Python control plane: the same strategy code runs in backtest and live, event-driven, nanosecond timestamps, 28 crates, adapters for crypto exchanges, Interactive Brokers, Databento and others. No Indian broker adapter. Very high engineering quality (extensive concept documentation, deterministic simulation testing, crash-only design).

**What I looked at.** README, ROADMAP, `docs/concepts/` (architecture, continuous futures, DST, data and catalog, bar, instruments, execution policies), the developer design principles, `crates/risk/src/sizing.rs`.

### 6.1 Continuous futures with explicit roll transitions (R11): the most useful idea for us
A continuous series is built from a list of roll transitions (time, pre-roll contract and price, post-roll contract and price). Four adjustment modes: backward or forward, spread (additive) or ratio (multiplicative). For backward spread the cumulative adjustment at segment k is the sum over later transitions of (post price minus pre price), anchored on the last contract, so price jumps at rolls disappear. Validation rules: transition times strictly increasing, chain continuous (each post contract equals the next pre contract), prices finite and positive for ratio mode. The continuous instrument is auto-synthesised from the first contract's specification.
**Ours today:** daily history covers only the current contract's life (66 days for crude); our volume roll chooses the front month but we store no roll record, so a stitched series is impossible.
**Better?** Yes. **Take:** (a) record every roll we detect (time, from-contract, to-contract, last and first prices) in a table, (b) a pure `adjustContinuous(segments, transitions, mode)` with tests copied from the rules above, (c) a "continuous" toggle in the chart feed. Nautilus's rule that the *target* bars are aggregated internally from per-segment source data also tells us to adjust at the 1-minute level, not on finished bars.

### 6.2 Bars and time: precise conventions
- `ts_event` (when it happened) and `ts_init` (when the system created the object) are separate; `time_bars_timestamp_on_close` defaults to true, and for **execution simulation, a bar's timestamp must be its close** so a bar is never visible before it formed.
- Bar invariants: high >= open, low, close; low <= open and close.
**Ours today:** `Bar.time` is the bar's open (as the providers and the charts use). That is fine for display but it is the exact trap Nautilus warns about for replay and any future backtest. **Take (R16):** write the convention down in `CLAUDE.md`, add a bar-invariant check on every provider ingest (drop or flag impossible bars instead of storing them), and make replay and the briefing use "available at close time".

### 6.3 Data-integrity policy
Design principles: invalid operations are rejected rather than coerced; failures are contained; executable invariants; recovery after failure uses the normal start-up path ("crash-only": abort on unrecoverable faults and let a supervisor restart). **Take:** adopt the stance for our own ingestion (never write a bar or quote we know is impossible) and make the stream and API restart cleanly under a supervisor (we mostly do; add a documented process-manager recipe).

### 6.4 Position sizing (R18)
`calculate_fixed_risk_position_size(instrument, entry, stop, equity, risk, commission, exchange_rate, hard_limit, unit_batch, units)`: risk a fixed fraction of equity, size = risk amount divided by (stop distance times contract multiplier plus costs), rounded to lot size, capped by a hard limit.
**Take:** a small pure function and a "position sizer" mini-panel (entry, stop, equity, risk %) that knows MCX lot sizes (100 bbl, 10 bbl, 1,250 and 250 mmBtu) and shows cost. We never place the order; it is a calculator.

### 6.5 What is not for us
The Rust core, the message bus, the cache, the portfolio and risk engines and live execution reconciliation exist to *run strategies safely*; we are a terminal. The DST (seeded, deterministic scheduling) machinery solves a problem we do not have. The Parquet data catalog solves large offline research; Timescale already serves our scale. The **"backtest and live differ" documentation** is worth reading before any backtester of ours.

---

## 7. openterminal (`ErTasselli/OpenTerminal`, MIT)

**What it is.** The Next.js plus Express terminal we benchmarked first; free public data, SQLite portfolio, optional Claude assistant. Last commit 2026-10-06 (error boundaries, symbol URL encoding, EU markets and ECB data, a market recap widget).
**Reviewed:** README, server providers and routes, the recap route, `concurrency.ts`, `cache.ts`, `ai.ts`.

We already match or beat it on every feature that matters to an energy desk (see CLAUDE.md). Remaining, small, and verified in code:

| Item | Theirs | Ours | Take |
|---|---|---|---|
| Cache bounds | LRU cap of 1,000 entries per cache because keys come from caller input | Our options-chain cache is keyed by a raw `expiry` query string and **has no cap** (`options.controller.ts`) | Cap it (and any cache keyed by user text): small real bug (R27) |
| User-agent | A per-process pool instead of one hardcoded UA | One fixed Chrome UA in `history.ts` and the news feeds | Small pool; low priority (R15) |
| Concurrency | `mapWithConcurrency(items, limit, fn)` for third-party fan-out | We hand-wrote batches of three in the insider controller | Extract one helper (R27) |
| Market recap | A **templated** (not AI) end-of-day paragraph from index, sector and mover data | We have the AI briefing but no no-cost summary | A deterministic one-paragraph "energy recap" (price, % move, inventory news, next release) costs nothing and works without an API key (R28) |
| AI route | No rate limit, no cost cap, no refusal handling beyond text | We have caching, a cap and error mapping | None; ours is stricter |

---

## 8. tensortrade (`tensortrade-org/tensortrade`, Apache-2.0)

**What it is.** A framework for training reinforcement-learning trading agents (Gym-style environment, action and reward schemes, wallets and an order-management model, a streaming feed DAG, stochastic price processes). About 12,800 lines. Last commit 2026-02-09; the docs and "testing report" are mostly maintenance notes. Python 3.12+.
**Reviewed:** README, architecture, the "common failures" tutorial, directory layout of `oms`, `feed`, `stochastic`.

**Relevance: low.** We are not training agents. Three lessons stand out:

1. **Costs decide whether an edge exists.** Their own experiments: the agent beats buy-and-hold by $594 at zero commission and loses $295 at 0.1%. For MCX this means any future strategy tooling must model real costs (R18) before showing a result, and a P&L view should always show the gross-to-net bridge.
2. **Overfitting is the default failure** (train up, validation down; use fewer features, early stopping, walk-forward). Same conclusion as Vibe-Trading's validation tools (R19).
3. **Stochastic processes** (`gbm`, `heston`, `merton` jumps, `ornstein_uhlenbeck` mean reversion, `fbm`) are ready-made generators. Our `FEED=demo` is a plain random walk; mean-reverting gas spreads and jump-diffusion crude would make the demo and any load test look like real markets (R17, optional).
The **composable feed DAG** (named streams that can be selected and combined) is a neat model for derived series (spreads, ratios) but we can get that with plain functions.

**Not worth adopting:** the RL stack itself, Ray/RLlib dependencies, or the BTC-centric examples.

---

## 9. forex-trading-ai-agent (K.I.T., MIT, a fork)

**What it is.** A Node/TypeScript "autonomous AI financial agent": 150 skills, brain with goal parser and decision engine, an autonomy manager, channels (Telegram, Discord, Slack, WhatsApp), exchange connectors, 94,000 lines. The README leads with marketing and a YouTuber promotion.
**Reviewed:** README, VISION, `src/brain/autonomy-manager.ts` and `decision-engine.ts`, gateway auth, `TEST_RESULTS.md`, source layout.

**Evidence of quality, from its own files.** The repository's `TEST_RESULTS.md` (2026-02-15) counts about 38 working, 70 partial and 66 broken of roughly 174 features, with MT5 integration partly broken and the Python skills about 20% working. The decision engine ships a **hardcoded fallback price table** (BTC 95,000, ETH 3,200 and so on) for when no exchange is connected, which is exactly the "synthetic data passed off as real" pattern OpenTerminalUI explicitly forbids. The gateway does bind to 127.0.0.1 and supports a token.

**Worth taking (one idea):** the **three autonomy levels** (assistant: suggest and wait; co-pilot: small actions automatic, large ask; autopilot: act and report) with **hard thresholds** (max trade size, max daily loss, max open positions, max percent of portfolio) and an automatic pause when a threshold trips. Its numbers are placeholders, but the shape is right and matches Vibe-Trading's mandate (R21). Also noted: model failover, retry and conversation compaction modules (R7), and channel delivery (R22).

**Do not take:** the 150-skill catalogue, wallet or bank integration ambitions, "wealth autopilot", or anything with hardcoded market data.

---

## 10. Cross-cutting themes (what the seven agree on)

| Theme | Who does it | Our status |
|---|---|---|
| AI output must be verified, not just cited | OpenTerminalUI, Vibe-Trading (grounding and run cards) | Cited, not verified |
| Every data point carries provenance and as-of time | OpenTerminalUI, OpenBB, Nautilus (ts_event/ts_init) | Partial (badges, not in the data) |
| Treat fetched text as untrusted input | Vibe-Trading (scanner), OpenTerminalUI | Prompt rule only |
| Spend limits and usage visibility for LLMs | Vibe-Trading, K.I.T. (failover) | Call cap only |
| Health checks that compare data, not just connectivity | Vibe-Trading canaries, OpenBB `test()` | Connectivity only |
| Standard provider contract, credential hints, record-and-replay tests | OpenBB | None |
| Server-side alerts with channels | OpenTerminalUI, Vibe-Trading, K.I.T. | Browser-only |
| Agent-facing interface (MCP) | OpenBB, OpenTerminalUI, Vibe-Trading | None |
| Write down the bar and time conventions | Nautilus | Implicit |
| Costs and validation before believing a backtest | tensortrade, Vibe-Trading | No backtester |
| Fail closed for anything that can lose money | Vibe-Trading, K.I.T., Nautilus | Not applicable (read-only) |

---

## 11. Proposed adoption backlog

Value: H (high) / M / L, for an energy trader using this terminal. Effort: S (under a day) / M (a few days) / L (a week or more). Source in brackets. "Needs" shows dependencies.

### A. Trust and AI quality
| ID | Item | Value | Effort | Needs |
|---|---|---|---|---|
| R1 | Grounding checker: verify every figure and statement in the briefing against the context facts; badge each point | H | M | none |
| R2 | Provenance (`source`, `quality`, `asOf`) on quotes, calendar events and context facts; Upstox-vs-TradingView conflict detection; freshness budgets | H | M | none |
| R3 | Prompt-injection scanner for headlines before they reach the model | H | S | none |
| R4 | Run manifest (prompt, context, model, version hashes) on each briefing; hash-chained journal | M | S-M | none |
| R5 | Briefing eval cases run in CI (fixed context, expected facts, deterministic verdicts) | M | M | R1 |
| R6 | One self-repair call when the checker finds a contradiction | M | S | R1 |
| R7 | Persisted daily token and cost accounting, a configurable cap, usage shown in the panel; model routing (cheap for notes, strong for synthesis) | H | S-M | none |
| R8 | Reflection notes: a one-paragraph lesson per graded briefing, fed into the next prompt | M | M | R4 |

### B. Data and domain
| ID | Item | Value | Effort | Needs |
|---|---|---|---|---|
| R9 | EIA petroleum and natural-gas storage actuals in the calendar (free keyless CSVs, verified); add `actual` and `revised` to the calendar event | H | S-M | R14 helps |
| R10 | CFTC positioning panel (managed money net, open interest, weekly change) for WTI and Henry Hub (free, verified) | H | M | none |
| R11 | Continuous futures: record rolls, pure adjustment function, "continuous" feed for charts and indicators | H | M-L | none |
| R12 | Futures curve panel: all listed MCX months and NYMEX months, calendar spreads, contango or backwardation, seasonality | H | M | R11 optional |
| R13 | Provider `Fetcher` contract and standard models for every external source | M | M | none |
| R14 | Scheduled source canaries (value checks, parser checks) and a start-up status table | M | S-M | R13 helps |
| R15 | Source-risk ordering and "explicit-only" label for misleading sources; UA pool | L | S | none |
| R16 | Bar invariants on ingest, written convention for bar timestamps, "available at close" for replay and briefings | M | S | none |
| R17 | Stochastic generators for the demo feed (mean reversion, jumps) | L | S | none |
| R33 | Chokepoints panel: daily tanker transits through Hormuz, Bab el-Mandeb, Suez and Malacca (IMF PortWatch, keyless, verified), with a rolling average and change flag; feeds the briefing | H | S-M | none |
| R34 | JODI oil and gas balances by country, India first (keyless archive, about 23.5 MB, monthly job) | M | M | R14 |
| R35 | EIA API v2 datasets (weekly stocks by product, refinery utilisation, product supplied, spot and NYMEX history) behind an optional free `EIA_API_KEY` | M | M | R13 |
| R36 | Record-and-replay HTTP fixtures for provider tests (real responses, refreshable) | M | S-M | R13 |
| R37 | Richer computed facts for briefing and screens: realized volatility and cones, ATR, Hurst exponent, regime flag, drawdown statistics (ported from `technical` and `quantitative`) | M | S-M | none |

### C. Trader tools
| ID | Item | Value | Effort | Needs |
|---|---|---|---|---|
| R18 | MCX cost engine (brokerage, CTT, exchange, SEBI, stamp, GST; rates configurable and verified against the Upstox schedule), lot and margin aware, with a fixed-risk position sizer; the shared base for R19 and R20 | H | M | none |
| R19 | Strategy tester with validation (Monte Carlo permutation, bootstrap CI, walk-forward) on stored candles; **in scope per your answer** | H | L | R18, R16, R11 |
| R20 | Paper trading on live quotes with slippage, a cost bridge and a trade journal; **in scope per your answer**. It is also the rehearsal for R21 | H | L | R18 |
| R26 | Trade journal from Upstox order history and "shadow account" rule extraction | M-H | L | positions access working |
| R21 | **Phase 2, gated:** real-time broker integration for order execution, designed on the mandate pattern (frozen hard caps loaded at start, fail-closed defaults, kill switch, human approval for writes, credential isolation, hash-chained audit log). Starts only when the gate below is met | later | L | R4, R20 and the gate |

### D. Platform and delivery
| ID | Item | Value | Effort | Needs |
|---|---|---|---|---|
| R22 | Server-side alerts evaluated in the stream service, with Telegram and webhook delivery | H | M | none |
| R23 | Read-only MCP server (tool discovery, bearer auth, stdio and HTTP) | H | M | R2 helps |
| R25 | Data-quality console (provider status row with last value and drift) | M | S-M | R14 |
| R27 | Cap every cache keyed by user input; one concurrency helper | M | S | none |
| R28 | Deterministic "energy recap" paragraph that needs no API key | M | S | R2 |
| R30 | Provider contract tests and a small Playwright end-to-end suite | M | M | R13 |
| R32 | Turn the commodity-team checklist (supply, demand, inventories, OPEC, rigs, SPR, seasonality, cost curve, geopolitics) into the briefing's required sections, each grounded on our data | M | M | R1, R9, R10 |

### Suggested order (updated for your answers)
1. **Hardening, same day:** R3, R27, R16.
2. **Trust and cost of the briefing:** R1, R2, R7, R4.
3. **Free data, visible in the UI:** R9, R10, R33, then R37 (richer computed facts), with R13 and R36 as the pattern underneath so each new source is a `Fetcher` with a recorded test, and R14 canaries.
4. **Cost engine first, then the strategy tools:** R18, then R11 (continuous futures, needed for honest history), R12 (curve), then R19 and R20.
5. **Reach:** R22 (alerts to Telegram and webhooks), R23 (MCP).
6. **On demand:** R5, R6, R8, R15, R17, R25, R26, R28, R30, R32, R34, R35.
7. **Phase 2 (R21), after the gate below.**

### The gate for Phase 2 (broker execution)
We stay research-only until all of these are true. This is my proposal; change it as you see fit.
- **Verified:** each Phase 1 feature has an owner-checked sign-off against live data during MCX hours (including Upstox positions, the options chain on a liquid expiry, and live depth), not only automated tests.
- **Tested:** the automated suite plus provider canaries (R14) have run green for a sustained period (suggest four weeks), and a written list of known failure modes exists.
- **Used:** real users have run the terminal daily for a sustained period (suggest four weeks) and their issues are closed or consciously deferred; the briefing journal's hit rate and the grounding checker's mismatch rate are known (R1, R4).
- **Rehearsed:** paper trading (R20) has run on live quotes long enough to match its fills and costs against what the broker actually charged on small manual trades.
- **Designed first:** the R21 design (mandate, kill switch, approval, credential isolation, audit chain) is reviewed together before any order code exists; credentials never enter the AI path.

## 12. Licences, in one place

| Repo | Licence | What it means for us |
|---|---|---|
| forex-trading-ai-agent | MIT | May reuse; nothing worth reusing |
| nautilus_trader | **LGPL-3.0** | **Do not copy code.** Concepts and the docs' ideas only; write our own implementation |
| OpenBB | Apache-2.0 (confirmed in the cloned `LICENSE`) | Code reusable with notice; we want the patterns, the tests approach, the indicator and statistics algorithms (ported, with attribution) and the public data endpoints |
| openterminal | MIT | Reusable; we are already past it |
| OpenTerminalUI | MIT | Reusable with notice; porting ideas to TypeScript anyway |
| tensortrade | Apache-2.0 | Reusable with notice; we only want ideas |
| Vibe-Trading | MIT | Reusable with notice (a `NOTICE` file exists); port the patterns |

Data terms: EIA and CFTC data are US government public data. TradingView, Yahoo and Upstox terms apply to what we already do; none of these repos changes that.

## 13. Decisions recorded

| # | Question | Your answer | What it changes |
|---|---|---|---|
| 1 | Re-clone OpenBB for a full read? | Yes, done | Section 3 rewritten; new backlog items R33 to R37 and a stronger R9 |
| 2 | AI-trust block or free-data block first? | Both | The order in section 11 interleaves them: hardening, then trust, then data |
| 3 | Telegram for alert delivery? | Yes | R22 uses a Telegram bot token you create, kept only in `.env`; webhook as the second channel |
| 4 | Research-only? | **Yes for now. Execution is a later phase** that starts after the relevant features are verified, tested and used by users | R21 becomes Phase 2 with the gate in section 11. Paper trading (R20) is the bridge. No order code, no broker write credentials, and no execution hooks exist until the gate is met |
| 5 | Backtester and paper trading wanted? | Yes | R19 and R20 are planned; R18 becomes the shared cost engine and lands first |

**Open points I still need from you when we reach them:** which Upstox cost schedule is the default for R18 (brokerage per order, any plan discounts); whether paper trading should follow MCX lot sizes and margin exactly (my recommendation) or a simplified one-contract model; whether the strategy tester starts with MCX crude and gas only; and whether the gate in section 11 (four weeks of green checks, four weeks of daily use) is the bar you want.
