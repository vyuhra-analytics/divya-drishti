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
- Single test file: `bun test packages/shared/src/candle.test.ts`
- Infra via Docker: `bun run infra:up` / `bun run infra:down`
- Schema (native Postgres, no psql needed): `bun run db:migrate`

## Architecture

- `packages/shared` — `@drishti/shared`: `Tick`/`Bar` types, `SYMBOLS`, `TIMEFRAMES`, `applyTick` (tick→candle merge used by web). Consumed as TS source, no build step.
- `apps/drishti-core-stream` — Elysia on Bun, port 3002. Mock random-walk feed (`src/feed.ts`) → WS topic `ticks:{symbol}` (client sends `{subscribe:[...]}`), Redis `PUBLISH ticks:{sym}` + `SET quote:{sym}`, batched insert into `ticks` every 1s. Uses Bun built-ins `SQL` and `RedisClient` (no pg/ioredis deps).
- `apps/drishti-core-api` — NestJS running under Bun (Bun emits decorator metadata; no nest-cli). Port 3001. `GET /health, /symbols, /quotes/:symbol, /bars?symbol&tf&from&to`. Bars come from the `bars_1m` Timescale continuous aggregate rolled up with `time_bucket`.
- `apps/drishti-web` — Vite React SPA, port 5173. Vite proxies `/api`→3001, `/ws`→3002; `VITE_API_URL`/`VITE_STREAM_URL` override for packaged Tauri.
  - `src/store.ts` — market data only (WS connection, quotes, session `day` bars via `applyTick`).
  - `src/workspace.ts` — persisted (localStorage) workspace: widgets, react-grid-layout layout, Bloomberg-style link groups (`group: null` = pinned to own symbol; `loadSymbol` on a grouped widget changes the whole group).
  - `src/Grid.tsx` — panel grid (react-grid-layout v2, `Responsive` + `useContainerWidth`). Named Grid, not Workspace, because `Workspace.tsx` and `workspace.ts` collide on case-insensitive filesystems.
  - `src/widgets.tsx` — widget registry `WIDGETS` (chart, quote, watchlist, tv; `linked`/`showSymbol` flags drive panel chrome). New widget = component + registry entry + `SIZE` and `WidgetType` in workspace.ts (+ optional mnemonic in command.ts).
  - `src/TvWidget.tsx` — live HLS TV; lazy-loads `hls.js/light` (hls.js first, native HLS only as fallback: Chrome reports native support but fails many streams). Channels live in settings (`tvChannels`); only official broadcaster streams.
  - `src/command.ts` — Ctrl+K palette parser (`TCS`, `TCS GP`, `GP`, `Q`, `W`, `TV`); mnemonics table `MNEMONICS`. UI in `Palette.tsx`.
  - `src/settings.ts` — persisted user settings (appearance, formatting, workspace, connection URL overrides). Theme/density/up-down colours are applied as `data-*` attributes on `<html>` and handled in CSS; `apiUrl()`/`streamUrl()` resolve override → env → dev proxy; `makeFormat` is cached. UI is a native `<dialog>` in `SettingsDialog.tsx` (gear button / Ctrl+,). Same case-collision rule: never name a component file like a lowercase module.
  - `Chart.tsx` loads history from API then applies live ticks via `store.subscribe` (no per-tick React render). Colours come from CSS tokens in `styles.css` (TradingView-style dark/light themes).
- `apps/drishti-desktop` — Tauri v2 shell, no custom Rust commands; dev loads `http://localhost:5173`, build bundles `drishti-web/dist`.
- `infra/sql/*.sql` — idempotent schema; mounted as Docker initdb and applied by `scripts/migrate.ts` natively.

Env lives in root `.env`; Bun apps load it with `--env-file=../../.env`, Vite via `envDir`. Apps must keep working with Docker and native infra — never hardcode container hostnames.
