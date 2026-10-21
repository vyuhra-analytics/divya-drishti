/** SVG polyline points for a sparkline of `values` in a w×h box (flat series draw mid-height); "" when under 2 points. */
export function sparkPoints(values: number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo;
  return values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(span === 0 ? h / 2 : h - ((v - lo) / span) * h).toFixed(1)}`)
    .join(" ");
}

export const TRAIL_MAX = 60;

/** Append a price to a trail, ignoring repeats, keeping the newest TRAIL_MAX. */
export function pushTrail(trail: number[] | undefined, price: number): number[] {
  if (trail && trail[trail.length - 1] === price) return trail;
  return [...(trail ?? []), price].slice(-TRAIL_MAX);
}
