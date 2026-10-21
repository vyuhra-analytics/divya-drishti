// Source canaries: run every source's real code path against the live provider on a schedule and say, per source, whether it still works.
// "No connectivity" is never a pass, and a source that answers but no longer parses is told apart from one we cannot reach.
import type { FetchIO } from "./fetcher";
import type { FixtureSample } from "./fixtureSamples";

export type CanaryStatus = "ok" | "unreachable" | "format" | "skipped";

export interface CanaryResult {
  id: string;
  status: CanaryStatus;
  /** epoch ms the check finished */
  at: number;
  ms: number;
  /** what went wrong, or why it was skipped */
  detail?: string;
}

/**
 * One check. `unreachable` = a request failed or the run threw before producing data; `format` = the provider answered but the
 * result fails the source's own check (it changed what it sends, or our parser broke): the case a plain uptime ping misses.
 */
export async function runCanary(s: FixtureSample, io: FetchIO): Promise<CanaryResult> {
  const t0 = io.now();
  const done = (status: CanaryStatus, detail?: string): CanaryResult => ({ id: s.id, status, at: io.now(), ms: io.now() - t0, ...(detail ? { detail } : {}) });
  const missing = (s.needs ?? []).filter((n) => !io.env[n]?.trim());
  if (missing.length) return { id: s.id, status: "skipped", at: io.now(), ms: 0, detail: `set ${missing.join(", ")}` };

  let failedRequests = 0;
  const watched: FetchIO = {
    ...io,
    async fetch(input, init) {
      try {
        const res = await io.fetch(input, init);
        if (!res.ok) failedRequests++;
        return res;
      } catch (e) {
        failedRequests++;
        throw e;
      }
    },
  };
  let result: unknown;
  try {
    result = await s.run(watched);
  } catch (e) {
    return done("unreachable", (e as Error).message);
  }
  const problem = s.check(result);
  if (!problem) return done("ok");
  return failedRequests ? done("unreachable", `${failedRequests} request(s) failed; ${problem}`) : done("format", problem);
}

/** Console table printed at start-up, one line per source. */
export function formatCanaryTable(results: CanaryResult[]): string {
  const w = Math.max(6, ...results.map((r) => r.id.length));
  const line = (r: CanaryResult) => `${r.id.padEnd(w)}  ${r.status.toUpperCase().padEnd(11)} ${String(r.ms).padStart(6)} ms  ${r.detail ?? ""}`.trimEnd();
  return [`${"source".padEnd(w)}  ${"status".padEnd(11)} ${"time".padStart(9)}`, ...results.map(line)].join("\n");
}
