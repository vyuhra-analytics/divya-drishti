// Things every chart starts with. Each is applied once per chart: after that the chart's own saved state decides, so a Volume pane the trader removes or a countdown they switch off stays that way.

const VOLUME_ID = "volume";

interface ChartLike {
  isDestroyed?: boolean;
  chart?: {
    indicators?: () => { indicatorId?: string }[];
    addIndicator?: (id: string, settings?: Record<string, unknown>) => unknown;
    setAxisChromeOptions?: (patch: { barCountdown?: boolean }) => void;
  };
}

// the volume flag keeps its first key (value "volume"), so charts set up before the countdown existed are not set up again
const keys = { volume: (id: string) => `drishti-adv-defaults-${id}`, countdown: (id: string) => `drishti-adv-defaults-countdown-${id}` };

function seen(feature: keyof typeof keys, id: string): boolean {
  try {
    return localStorage.getItem(keys[feature](id)) === feature;
  } catch {
    return false;
  }
}

function remember(feature: keyof typeof keys, id: string): void {
  try {
    localStorage.setItem(keys[feature](id), feature);
  } catch {
    /* blocked storage: the default may be applied again next time */
  }
}

/** Runs `apply` once the chart is ready (it is created a moment before its API answers), at most once per chart and feature. `settle` waits that many tries so saved studies and settings can load first. */
function once(widget: unknown, widgetId: string, feature: keyof typeof keys, settle: number, apply: (c: NonNullable<ChartLike["chart"]>) => void): void {
  if (seen(feature, widgetId)) return;
  const w = widget as ChartLike;
  let tries = 0;
  const attempt = () => {
    tries++;
    try {
      if (w.isDestroyed) return;
      if (w.chart && tries >= settle) {
        apply(w.chart);
        return remember(feature, widgetId);
      }
    } catch {
      /* the chart is not ready yet */
    }
    if (tries < 12) setTimeout(attempt, 800);
  };
  setTimeout(attempt, 800);
}

/** Volume bars in their own pane, coloured by the candle's direction ("Match candle direction"), and the countdown to the bar's close in the last-price tag. */
export function ensureChartDefaults(widget: unknown, widgetId: string): void {
  // saved studies come back a moment after creation: only add Volume when none of them is a volume pane
  once(widget, widgetId, "volume", 3, (c) => {
    if (c.indicators && c.addIndicator && !c.indicators().some((i) => i.indicatorId === VOLUME_ID)) c.addIndicator(VOLUME_ID, { colorByDirection: true });
  });
  once(widget, widgetId, "countdown", 2, (c) => c.setAxisChromeOptions?.({ barCountdown: true }));
}
