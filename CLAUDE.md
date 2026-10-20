# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Divya Drishti — personal Bloomberg-style market terminal, built incrementally. Owner presents it as their own work (MIT). Do not commit without the owner's review.

## Commands

- Install: `bun install` (Bun workspaces; `cp .env.example .env` first run)
- Dev (stream + api + web via Turborepo): `bun run dev`
- Desktop (needs web dev server running): `bun run desktop`
- Typecheck all: `bun run typecheck`
- Tests (bun:test, whole repo): `bun test`
- Single test file: `bun test packages/shared/src/markets.test.ts`
- Simulated prices (offline/weekends): `FEED=demo` in `.env`
- Infra via Docker: `bun run infra:up` / `bun run infra:down`
- Schema (native Postgres, no psql needed): `bun run db:migrate`

## Architecture

- `packages/shared` — `@drishti/shared`, consumed as TS source (no build step). `INSTRUMENTS` catalogue (6 energy futures: MCX crude/natgas standard+mini, NYMEX CL/NG; per-source codes, exchange `timeZone`, decimals, delay), `Quote` (stream message) / `Tick` / `Bar`, and pure helpers: `applyTick` + `bucketStart` (candles bucketed in exchange time via `tzOffsetSec`, matching provider history), `quoteToTick` (volume delta), `pickSource` (fallback rule), `frontMonth` / `tvContract`, history parsers + `normalizeBars`, `upstoxTokenExpiry`.
- `apps/drishti-core-stream` — Elysia on Bun, port 3002. Providers in `src/providers/` (`upstox/` protobuf WS feed using the vendored `MarketDataFeed.proto`, `tradingview.ts` scanner poll, `yahoo.ts` chart poll, `demo.ts` for `FEED=demo`); every quote goes through `accept()` in `index.ts`, which publishes only the active source per symbol (`pickSource`, 15 s staleness) to WS topic `quotes:{symbol}` + Redis, sends the cached snapshot on subscribe, and batches ticks into Timescale. MCX front months come from Upstox's public instrument master (`contracts.ts`); TradingView MCX must use dated codes (`CRUDEOILX2026`) because its MCX `1!` rolls late. `/health` has per-provider stats. `src/news.ts` polls ~10 energy RSS feeds (Google News searches, OilPrice, CNBC, Rigzone, Yahoo, ET, EIA), parses/tags/dedupes with shared `news.ts` (`parseRss`, `tagNews`, `dedupeNews`: one item per story = the earliest copy kept whole (publisher/link/time never mixed), every other outlet that ran the same headline kept in `copies` with its own link and time (panel: one chip per outlet under the headline, first report marked, >4 collapse into "+N"), 48 h, 600 max; tags crude = crude-market words, oil = any oil/oil-market headline). Includes OpenTerminal's own OIL sources (Google `OIL stock`, Yahoo `OIL`); strict feeds keep only headlines with an energy keyword, keeps them in memory + Redis `news:latest`, and pushes new items on WS topic `news` (`{type:"news", items}`; full list on subscribe).
- `apps/drishti-core-api` — NestJS running under Bun (Bun emits decorator metadata; no nest-cli). Port 3001. `/bars?symbol&tf` = provider history (`history.ts`: Yahoo for NYMEX, Upstox for MCX) cached 30 s and written through to the `candles` hypertable; falls back to `candles` + `bars_1m` rollup when the provider can't answer. `upstox.controller.ts`: OAuth login → token in Redis `upstox:token` (expires 03:30 IST) which the stream polls; secrets only in `.env`, token never returned or logged.
- `apps/drishti-web` — Vite React SPA, port 5173. Vite proxies `/api`→3001, `/ws`→3002; `VITE_API_URL`/`VITE_STREAM_URL` override for packaged Tauri.
  - `src/store.ts` — market data only (WS connection, latest `Quote` per symbol). `Feeds.tsx` = Settings → Data feeds (Upstox connect + provider health via the `/stream` Vite proxy).
  - `src/workspace.ts` — persisted (localStorage) workspace: widgets, react-grid-layout layout, Bloomberg-style link groups (`group: null` = pinned to own symbol; `loadSymbol` on a grouped widget changes the whole group).
  - `src/Grid.tsx` — panel grid (react-grid-layout v2, `Responsive` + `useContainerWidth`). Named Grid, not Workspace, because `Workspace.tsx` and `workspace.ts` collide on case-insensitive filesystems.
  - `src/widgets.tsx` — widget registry `WIDGETS` (chart, quote, watchlist, tv; `linked`/`showSymbol` flags drive panel chrome). New widget = component + registry entry + `SIZE` and `WidgetType` in workspace.ts (+ optional mnemonic in command.ts).
  - `src/TvWidget.tsx` — live HLS TV; lazy-loads `hls.js/light` (hls.js first, native HLS only as fallback: Chrome reports native support but fails many streams). `BUILTIN_CHANNELS` (Bloomberg US/EU/Asia/TV+/Originals via bloomberg.com manifests, CNBC-TV18 via Network18's CDN, NDTV Profit) + user channels from settings (`tvChannels`), deduped by URL; selected channel persisted per widget (`Widget.channel`); first built-in (Bloomberg TV+) is the default. Pause/resume is DVR-style; "GO LIVE" lag = `hls.latency - hls.targetLatency` while playing, wall clock while paused (latency only refreshes per playlist reload when paused). Only official broadcaster streams, never third-party restreams.
  - `NewsWidget.tsx` — energy headlines from the store (`news`), filters Linked (instrument `topic` → `TOPIC_TAGS`: crude instruments show crude + oil) / All / Crude / Oil / Nat Gas / India; links opened only if `isSafeUrl`.
  - `src/command.ts` — Ctrl+K palette parser (`CRUDEOIL`, `CL GP`, `GP`, `Q`, `W`, `TV`, `N`); mnemonics table `MNEMONICS`. UI in `Palette.tsx`.
  - `src/settings.ts` — persisted user settings (appearance, formatting, workspace, connection URL overrides). Theme/density/up-down colours are applied as `data-*` attributes on `<html>` and handled in CSS; `apiUrl()`/`streamUrl()` resolve override → env → dev proxy; `makeFormat` is cached; `formatStamp`/`useClock` render every time shown (news, quote, Upstox expiry, chart axis/crosshair in local time) with the 12h/24h `clock` setting. UI is a native `<dialog>` in `SettingsDialog.tsx` (gear button / Ctrl+,). Same case-collision rule: never name a component file like a lowercase module.
  - `Chart.tsx` loads history from API then applies live ticks via `store.subscribe` (no per-tick React render). Colours come from CSS tokens in `styles.css` (TradingView-style dark/light themes).
- `apps/drishti-desktop` — Tauri v2 shell, no custom Rust commands; dev loads `http://localhost:5173`, build bundles `drishti-web/dist`.
- `infra/sql/*.sql` — idempotent schema; mounted as Docker initdb and applied by `scripts/migrate.ts` natively.

Env lives in root `.env`; Bun apps load it with `--env-file=../../.env`, Vite via `envDir`. Apps must keep working with Docker and native infra — never hardcode container hostnames.
