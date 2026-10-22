/**
 * lightweight-charts treats times as UTC: day/month ticks would fall on UTC midnight (05:30 IST, 8 pm New York).
 * Standard fix: hand it local wall-clock time (real UTC seconds + the viewer's offset at that instant), so its
 * "UTC" boundaries are our local ones, and convert back when labelling the crosshair.
 */
const localOffsetSec = (sec: number) => -new Date(sec * 1000).getTimezoneOffset() * 60;
export const toChartTime = (sec: number) => sec + localOffsetSec(sec);
export const fromChartTime = (t: number) => t - localOffsetSec(t - localOffsetSec(t)); // inverse, DST-safe except the switch hour
