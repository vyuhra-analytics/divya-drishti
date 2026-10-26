// How much of an MCX session the recording covers. The stream writes a `feed_minutes` row for every minute it ran and heard from Upstox; the
// minutes of the session without one (stream stopped, token expired, feed silent) are the holes. Pure, so the arithmetic is tested.

const MIN = 60_000;

export interface CoverageGap {
  /** first missing minute, epoch ms */
  from: number;
  /** end of the last missing minute (exclusive), epoch ms */
  to: number;
  minutes: number;
}

export interface Coverage {
  expectedMinutes: number;
  coveredMinutes: number;
  /** 0 to 1; 1 when the window is empty */
  ratio: number;
  gaps: CoverageGap[];
}

/**
 * `present` are the minutes (epoch ms, any offset inside the minute) with feed messages. The window [start, end) is cut to whole minutes. Runs of
 * missing minutes of at least `minGapMinutes` are listed; shorter ones still count against the ratio (a quiet minute is not a hole, but a
 * single missing row cannot be told from one).
 */
export function coverage(present: readonly number[], start: number, end: number, minGapMinutes = 2): Coverage {
  const first = Math.ceil(start / MIN) * MIN;
  const last = Math.floor(end / MIN) * MIN;
  const have = new Set(present.map((t) => Math.floor(t / MIN) * MIN));
  const gaps: CoverageGap[] = [];
  let covered = 0;
  let expected = 0;
  let runStart: number | undefined;
  const close = (at: number) => {
    if (runStart === undefined) return;
    const minutes = (at - runStart) / MIN;
    if (minutes >= minGapMinutes) gaps.push({ from: runStart, to: at, minutes });
    runStart = undefined;
  };
  for (let t = first; t < last; t += MIN) {
    expected++;
    if (have.has(t)) {
      covered++;
      close(t);
    } else if (runStart === undefined) runStart = t;
  }
  close(last);
  return { expectedMinutes: expected, coveredMinutes: covered, ratio: expected ? covered / expected : 1, gaps };
}
