import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { createRunner, eiaSeriesFetcher, EIA_SERIES, limiter, SourceError, withUserAgent, type EiaSummary } from "@drishti/shared";

const TTL_MS = 3600_000; // the fetcher's own freshness: weekly data (spot prices daily), so an hourly look is plenty
const RETRY_MS = 5 * 60_000; // after a series fails with no copy to fall back on, leave it alone this long
const WAIT_MS = 8_000; // how long one request waits for stragglers; a slow series keeps loading and shows on the next request
const gate = limiter(4); // EIA is slow and rate-limited: never more than 4 of the ten series in flight
const run = createRunner({ fetch: (input, init) => gate(() => fetch(input, withUserAgent(input, init))), env: process.env, now: Date.now }, 16);
const entries = new Map<string, { at: number; summary: EiaSummary; stale?: boolean }>();
const nextTry = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();

/** EIA's routes vary from 1 s to 45 s for the same call (natural gas worst), so each series loads on its own through the Fetcher runner and never blocks the others. */
function refresh(id: string): Promise<void> {
  const running = inflight.get(id);
  if (running) return running;
  const p = run(eiaSeriesFetcher, { id })
    .then((r) => void entries.set(id, { at: r.fetchedAt, summary: r.data, ...(r.stale ? { stale: true } : {}) }))
    .catch(() => void nextTry.set(id, Date.now() + RETRY_MS))
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/**
 * EIA Open Data v2: US crude, Cushing, gasoline, distillate and SPR stocks, refinery utilisation, product supplied and
 * WTI / Brent / Henry Hub spot, each against last week, last year and the five-year average. Needs a free `EIA_API_KEY`
 * (eia.gov/opendata); the shared DEMO_KEY allows only ~10 calls an hour, so it is never used. GET /eia
 */
@Controller("eia")
export class EiaController {
  @Get()
  async eia() {
    if (!process.env.EIA_API_KEY?.trim()) throw new ServiceUnavailableException(new SourceError("credentials", `Set EIA_API_KEY in .env (${eiaSeriesFetcher.instructions})`).message);
    const now = Date.now();
    const loading = EIA_SERIES.filter((s) => {
      const e = entries.get(s.id);
      return (!e || now - e.at > TTL_MS) && now >= (nextTry.get(s.id) ?? 0);
    }).map((s) => refresh(s.id));
    if (loading.length) await Promise.race([Promise.all(loading), new Promise((r) => setTimeout(r, WAIT_MS))]);
    if (entries.size === 0 && inflight.size === 0) throw new ServiceUnavailableException("EIA returned no data (check EIA_API_KEY)");
    const stale = EIA_SERIES.some((s) => { const e = entries.get(s.id); return !!e && (e.stale || e.at < now - TTL_MS - RETRY_MS); }); // a copy we could not refresh
    return {
      series: EIA_SERIES.map((s) => ({ ...s, ...(entries.get(s.id)?.summary ?? { id: s.id }) })),
      fetchedAt: Math.max(0, ...[...entries.values()].map((e) => e.at)),
      ...(stale ? { stale } : {}),
    };
  }
}
