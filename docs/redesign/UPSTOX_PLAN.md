# Upstox: what we pull, what we should have, and the specs (2026-10-22)

Paper specs, in the agreed order. Nothing here is built. Evidence labels: **tested** (a read-only call or a live feed test with the owner's token on 2026-10-22), **documented** (Upstox's own pages, not tested), **unknown**.

## A. What we pull today

| Upstox API | Used for | Notes |
|---|---|---|
| OAuth login and token exchange | the daily login token (expires 03:30 IST), or the `.env` token | |
| Market Data Feed V3, WebSocket, mode `full` | live quotes for the 6 MCX front futures | we read price, previous close, day OHLC, volume, best bid/ask, OI, ATP, buy/sell quantity; the other 4 of 5 depth levels are ignored |
| Historical and intraday candles V3 | chart history for MCX | the OI field in each candle is dropped |
| Public instrument master (MCX) | front months, option contracts | |
| Market quotes v2 and Option Greeks v3 | the option chain, polled every 3 s | |
| Market timings and holidays | session rules, calendar | |
| Short-term positions | briefing position context | answers 401 (static IP, see item 5) |

## B. Facts established today

- **Brokerage Details API (tested):** at a Rs 500 premium, one crude option buy costs Rs 61.62 and a sell Rs 85.12. Brokerage is **Rs 30 per order** (our table says Rs 20); exchange charge, CTT, stamp duty, SEBI and GST (18% on brokerage + exchange + SEBI) all match our table. Futures exchange charge is **0.0021%** (resolves the 0.0021 / 0.0026 doubt). Not yet known whether Rs 30 is Upstox's standard rate or the owner's plan.
- **Option candles (tested):** `historical-candle` works for a live option (CRUDEOIL 9450 CE 17 Nov 26): 2,991 one-minute candles for 15 to 22 Oct, **seventh field = open interest per minute**; futures candles carry it too.
- **WebSocket carries MCX option keys (tested live):** `full` mode for `MCX_FO|582939` (the 9450 CE) returned LTP, **5 depth levels**, OI, volume, **IV and delta / theta / gamma / vega / rho**, about one message a second per key. Normal plan: 2 connections, 2,000 keys in `full` mode (documented).
- **Account endpoints (tested):** funds, order book, trades, positions, profile, historical trades and P&L reports all answer 401 `UDAPI1221`: only from the **static IP registered in the Upstox account**.
- **Market Status API (tested):** `GET /v2/market/status/MCX` answers (`NORMAL_OPEN`).
- **Not usable for MCX (tested):** Put/Call Option Chain API (empty), PCR and Max Pain APIs (`data: null`), expired instruments (MCX not supported, documented).

---

## Spec 1: costs from Upstox's own calculation

**Why.** The cost table is our biggest "unverified" number and is wrong by Rs 10 per order (about Rs 24 on a Rs 500 round trip at 100 bbl: 16%), more on small premiums and gas.
**What.**
- API `GET /costs/brokerage?key&qty&price&side&product` proxies Upstox's Brokerage Details (cached 10 minutes per input).
- Costs panel and paper trading use the table, **default brokerage corrected to Rs 30**, and show "checked against Upstox on <date>" when the API agrees.
- A recorded-fixture contract test (the same pattern as the other sources) fixes six sample legs (option buy and sell, future buy and sell, small and large premium) and fails if the table drifts from Upstox's numbers by more than Rs 0.50 per leg. A canary re-checks them weekly.
**Acceptance (trader terms).** For the 6 sample legs the table and the API agree within Rs 0.50; the Costs panel shows the round trip for one crude option at the owner's premium within Rs 1 of what Upstox's contract note will say (checked once against a real contract note when the owner has one: that closes the old verification debt).
**Risks.** Brokerage may be plan-specific: the API is per token, so the check must run with the owner's token; if it differs by instrument class, the table keeps one rate per class.
**Size.** Small. No new data.

## Spec 2: live option premium over the WebSocket

**Why.** The trade block and the chain need the traded strike's premium, bid/ask and greeks without a 3-second lag. The feed already carries all of it (tested).
**What.**
- The stream's Upstox connection takes a **demand-driven watch list**: the web app (or the API) names the option keys it wants (the chain's 4 to 8 strikes around the money, plus the traded one), the stream adds them to the `full` subscription and unsubscribes when nobody asks. Limit: at most 40 option keys at once (far below the 2,000 cap); keys must come from the contract list the API already holds (never a caller-supplied string).
- New message type on a topic `options:<key>` carrying key, last price and time, bid / ask with quantity, 5 depth levels, OI, volume, IV, delta, theta, gamma, vega. Provenance as for quotes (live / stale; the feed's own tick time, not the receive time).
- The chain panel and the trade block read it; the existing HTTP chain remains the fallback when the feed is silent (the badge says which).
**Acceptance.** (1) On a live evening, the displayed premium of the traded strike is within 1 second of the exchange tick time (the feed's `ltt`) at the 95th percentile over 15 minutes, logged. (2) The chain updates a strike row within 1 second of a trade on it. (3) If the feed stops, the chain falls back to HTTP and says so within 15 seconds.
**Risks.** A second connection would count against the 2-connection limit: reuse the one connection. Greeks in the feed are Upstox's; they may differ from the HTTP greeks used today (compare once, report the gap).
**Size.** Medium: stream, protocol, web store. Depends on nothing else.

## Spec 3: OI per minute and option candles, recorded and kept

**Why.** Candles already carry OI per minute and we throw it away. Option price history is the data our strategy study lacked, and live-contract history rolls off when the contract expires.
**What.**
- Keep the OI field: optional `oi` on bars, a nullable `oi` column on `candles` (migration), returned by `/bars`; validation rejects negative or non-integer OI.
- **Option candle recorder:** every evening after the close and on weekends, fetch one-minute candles (with OI) for the contracts we care about and write them to a new table `option_candles` (key, symbol, underlying, expiry, strike, type, time, OHLC, volume, OI). Scope: CRUDEOIL and NATGASMINI, the first two expiries, strikes within 5 steps of the money, calls and puts. Estimated about 20,000 rows a day per underlying (our estimate; a few GB a year uncompressed; Timescale compression applies).
- `db:clean` is told not to touch this table; it is append-only.
- The EIA-day recording: on WPSR and WNGSR days also record the chain minute by minute during the window (this is the "chain snapshots" item from the data plan).
**Acceptance (revised after the first live run, 2026-10-22).** Upstox returns a candle for every minute from a contract's first trade (forward-filled), so "expected minutes" is not a useful yardstick; the check is that **the stored candles equal what Upstox returns for the same window** (done for the at-the-money call on 21 Oct: 870 of 870, 0 differences, open interest included), that after 5 evenings every selected contract that trades has its sessions stored, and that a replayed premium series for a report day can be built from stored data without the simulation used in the prototype. Implementation note: the dated candle endpoint never includes the current day, so the recorder takes today from the intraday endpoint.
**Risks.** Candle requests are one month per call and rate-limited (the history code already limits itself); strikes drift: record by distance from the money at the time of recording, not a fixed list.
**Size.** Medium. Pays off over months, not immediately.

## Spec 4: authoritative market status

**Why.** We infer OPEN or CLOSED from timings and rules. Upstox publishes the exchange status itself (`NORMAL_OPEN`, `NORMAL_CLOSE`, and others).
**What.** The API polls `/v2/market/status/MCX` every 30 seconds (and once at start); the stream's `symbolLive` treats a status other than an open state as CLOSED regardless of the rules, and the rules remain the fallback when the call fails. The status bar shows the raw status text on hover.
**Acceptance.** On a holiday or an early-close day the badge flips to CLOSED within 60 seconds of Upstox's status; the existing session tests keep passing; the smoke test checks the route answers.
**Risks.** Unknown set of status values: log every distinct value seen and treat unknown values as "no opinion", never as closed.
**Size.** Small.

## Spec 5: account reads (needs the static IP)

**Blocked on the owner.** Upstox answers these only from a registered static IP, which the owner must set in their Upstox app settings. We do not know whether the home connection has a fixed address; the options are an ISP static IP or a small always-on relay on a server with one. We also do not know whether the long-lived analytics token is allowed at all; the daily OAuth login token probably is.
**What, once reads work (all read-only; no order placement, GTT or modification, ever, until the gated execution phase):**
- **Funds**: available funds feed the "premium fits capital" rule in the strike pick.
- **Trades of the day and trade history, order history**: build the owner's real-trade journal and reconcile it against the app's signals (which signal, entry slippage versus the next future open, which exit ended the day).
- **P&L and charges reports**: check our costs (spec 1) against Upstox's own per-trade charges.
- **Portfolio Stream (WebSocket)**: detect the owner's real entry and exit automatically, so the IN TRADE state and the one-trade-a-day lock no longer depend on pressing buttons.
**Privacy.** Account data stays on this machine; nothing goes to the AI service unless the owner ticks it, as with positions today; the token never leaves the server.
**Acceptance.** `bun run smoke` gets an "account read access" check that skips cleanly when the IP is not registered; with access, a real fill appears in the journal within 5 seconds, and a day's charges match Upstox's report within Rs 1.
**Size.** Medium to large; the first step is the owner's (registering the IP) and a 10-minute test of which endpoints answer.

## Not worth doing

- **PCR, Max Pain, Change in OI, OI APIs for MCX**: PCR and Max Pain answer `data: null` for MCX. We compute these ourselves from the chain, and keep doing so.
- **Option Chain API for MCX**: empty (tested).
- **Expired MCX history**: not offered.
- **IPOs, mutual funds, fundamentals, payouts, news**: no use in this app.
- **Place order, GTT, exit all, kill switch**: the later, gated execution phase (and the static IP is a regulatory requirement there as well).

## Order and dependencies

1. Spec 1 (costs). 2. Spec 4 (market status; small, can go with 1). 3. Spec 2 (premium over the WebSocket). 4. Spec 3 (OI and option candles; starts accumulating value the day it runs, so it should start early). 5. Spec 5 when the owner has a static IP.
