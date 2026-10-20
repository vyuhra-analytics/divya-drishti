# divya-drishti
Divya Drishti (Divine Vision) represents the ultimate power of omniscience, infinite foresight, and all-seeing perception. Originating from the Mahabharata, it describes a supreme capability to see through physical barriers, track events across vast distances in real-time, and perceive hidden truths far beyond ordinary human sight.

A personal market terminal, built step by step.

## Stack

| Layer | Tech | Location |
|---|---|---|
| Monorepo | Turborepo + Bun workspaces | `/` |
| Streaming backend | ElysiaJS on Bun | `apps/drishti-core-stream` |
| Business backend | NestJS (runs on Bun) | `apps/drishti-core-api` |
| Web | React + Vite + TypeScript, Zustand, Lightweight Charts | `apps/drishti-web` |
| Desktop | Tauri v2 (loads drishti-web) | `apps/drishti-desktop` |
| Shared types/logic | TypeScript | `packages/shared` |
| Time-series DB | PostgreSQL 17 + TimescaleDB | `infra/sql` |
| Cache / pub-sub | Redis (or Memurai on Windows) | — |

## Instruments and data sources

Energy futures, each as a continuous front-month contract (the actual contract, e.g. `CRUDEOIL FUT 19 NOV 26`, is shown in the quote panel):

| Symbol | Instrument | Live source (fallback) | Chart history | Freshness |
|---|---|---|---|---|
| `MCX:CRUDEOIL`, `MCX:CRUDEOILM` | Crude Oil, Crude Oil Mini | Upstox market feed (TradingView scanner) | Upstox | real-time |
| `MCX:NATURALGAS`, `MCX:NATGASMINI` | Natural Gas, Natural Gas Mini | Upstox market feed (TradingView scanner) | Upstox | real-time |
| `NYMEX:CL` | WTI Crude Oil | Yahoo Finance (TradingView scanner) | Yahoo | 10 min delayed |
| `NYMEX:NG` | Henry Hub Natural Gas | Yahoo Finance (TradingView scanner) | Yahoo | 10 min delayed |

- A source that goes quiet for 15 s hands over to the next one; Settings → Data feeds shows which source serves each symbol.
- Without an Upstox login MCX prices still stream (TradingView), but MCX charts only show candles built since you opened them (plus anything stored in TimescaleDB).
- Yahoo and the TradingView scanner are unofficial endpoints: free, no key, but they can change without notice.
- `FEED=demo` in `.env` swaps all sources for a simulated random walk (weekends, offline work).
- Market hours: MCX energy roughly 09:00–23:30 IST (23:55 when the US is on winter time), Monday to Friday; NYMEX almost 24 h, Sunday evening to Friday (US time).

### News

The **News** panel (`+ News` or `N` in the command palette) streams energy headlines from about ten free RSS feeds: Google News searches for crude, natural gas and MCX, plus OilPrice.com, CNBC energy, Rigzone, Yahoo Finance (CL=F / NG=F), Economic Times commodities and EIA. The stream service polls them every 1–2 minutes, merges duplicates of the same story, tags each headline Crude / Nat Gas / India, and pushes new ones to the app as they appear. "Linked" shows the topic of the panel's linked symbol.

### Upstox setup (MCX real-time)

1. Create an app at [account.upstox.com/developer/apps](https://account.upstox.com/developer/apps) with redirect URL `http://localhost:3001/auth/upstox/callback`.
2. Put its key and secret in `.env` as `UPSTOX_API_KEY` / `UPSTOX_API_SECRET` and restart the API.
3. Each trading day: Settings (⚙ or Ctrl+,) → Data feeds → **Connect Upstox**, log in on upstox.com. Tokens expire at 03:30 IST. Needs Redis running.

## Data flow

```
Upstox WS / TradingView / Yahoo ─▶ drishti-core-stream ──WS /ws (quotes)──▶ drishti-web (live candles)
                                        │  │
                                        │  └─ Redis: PUBLISH quotes:{sym}, SET quote:{sym}, fronts
                                        └──── TimescaleDB: ticks hypertable ─▶ bars_1m continuous aggregate

drishti-web ◀── GET /bars ── drishti-core-api ── Yahoo / Upstox history ─▶ TimescaleDB candles (write-through)
            ◀── Upstox login ─┘                        (falls back to candles + bars_1m when a provider can't answer)
```

| Service | Port |
|---|---|
| drishti-web (Vite) | 5173 |
| drishti-core-api | 3001 |
| drishti-core-stream | 3002 |
| PostgreSQL | 5432 |
| Redis | 6379 |

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 — `winget install Oven-sh.Bun`
- Rust + MSVC Build Tools (desktop app only) — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- Infra, **either** Docker **or** native installs (below)

```bash
bun install
cp .env.example .env
```

## Run with Docker

```bash
bun run infra:up
```

```bash
bun run dev
```

The schema is applied automatically on first container start (`infra/sql` is mounted as initdb scripts).

## Run without Docker (native Windows)

1. **PostgreSQL 17** — EDB installer from postgresql.org. Create user/db matching `.env` (`drishti`/`drishti`).
2. **TimescaleDB** — download the Windows zip for PG17 from the TimescaleDB releases page, run `setup.exe` as admin (adds `timescaledb` to `shared_preload_libraries`), restart the PostgreSQL service.
3. **Redis** — `winget install Memurai.MemuraiDeveloper` (Redis-compatible, runs as a service on 6379).
4. Apply schema and start:

```bash
bun run db:migrate
```

```bash
bun run dev
```

The apps only read `DATABASE_URL` / `REDIS_URL`, so they behave the same either way. They also boot with infra down: `/health` reports `postgres:false` / `redis:false`, live ticks still stream to the web UI.

## Desktop

Start the web dev server (`bun run dev`), then:

```bash
bun run desktop
```

For a packaged build set `VITE_API_URL=http://localhost:3001` and `VITE_STREAM_URL=ws://localhost:3002/ws` in `.env`, then `bun run --cwd apps/drishti-desktop build`.

## Checks

```bash
bun run typecheck
```

```bash
bun test
```

## License

MIT
