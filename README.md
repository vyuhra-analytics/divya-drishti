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

## Data flow (step 1)

```
mock random-walk feed ─▶ drishti-core-stream ──WS /ws──▶ drishti-web (live candles)
                              │  │
                              │  └─ Redis: PUBLISH ticks:{sym}, SET quote:{sym}
                              └──── TimescaleDB: ticks hypertable ─▶ bars_1m continuous aggregate
                                                                        │
drishti-web ◀── GET /bars, /quotes, /symbols ── drishti-core-api ◀──────┘
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
