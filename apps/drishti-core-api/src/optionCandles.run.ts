import { mapLimit, mergeBars, optionCandlesUrl, optionIntradayUrl, parseUpstoxCandles, recordingWindow, selectRecordingContracts, validateBars, type Bar, type OptionContract } from "@drishti/shared";

/** What a recording needs from outside, so the run itself is tested with fakes. */
export interface RecordDeps {
  now: number;
  /** when the last recording finished (epoch ms), undefined if never */
  lastRunAt?: number;
  /** option contracts of the instrument master */
  contracts: () => Promise<OptionContract[]>;
  /** an authenticated Upstox GET returning the parsed JSON; throws on a non-2xx answer */
  get: (url: string) => Promise<any>;
  store: {
    upsertContracts(contracts: OptionContract[]): Promise<void>;
    /** write candles, ignoring ones already stored; returns how many were new */
    insertCandles(key: string, bars: Bar[]): Promise<number>;
  };
  /** Upstox requests in flight at once */
  concurrency?: number;
}

export interface RecordSummary {
  window: { from: string; to: string };
  contracts: number;
  /** contracts whose candles were fetched and stored without an error */
  fetched: number;
  failed: number;
  candles: number;
  inserted: number;
  /** candles refused as impossible (see validateBars) */
  dropped: number;
}

/** Upstox keyed quote responses use "EXCHANGE:SYMBOL" keys; every entry carries instrument_token ("MCX_FO|123"). */
const lastPriceByToken = (json: any): Record<string, number | undefined> =>
  Object.fromEntries(Object.values<any>(json?.data ?? {}).map((v) => [v?.instrument_token as string, typeof v?.last_price === "number" ? (v.last_price as number) : undefined]));

/**
 * Copy the one-minute candles (prices, volume, open interest) of the contracts we keep history for: the nearest two expiries of crude and gas mini,
 * five strikes either side of the money. Idempotent: a candle already stored is left alone, so a repeat or an overlapping window adds nothing.
 * One contract failing does not stop the rest; the caller decides from `failed` whether the run counts.
 */
export async function recordOptionCandles(d: RecordDeps): Promise<RecordSummary> {
  const window = recordingWindow(d.lastRunAt, d.now);
  const contracts = await d.contracts();
  const futureKeys = [...new Set(selectRecordingContracts(contracts, {}, d.now).map((c) => c.underlying_key))];
  if (!futureKeys.length) throw new Error("no option contracts to record in the instrument master");
  const quotes = await d.get(`https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(futureKeys.join(","))}`).catch(() => null);
  const selected = selectRecordingContracts(contracts, lastPriceByToken(quotes), d.now);
  await d.store.upsertContracts(selected);

  const summary: RecordSummary = { window, contracts: selected.length, fetched: 0, failed: 0, candles: 0, inserted: 0, dropped: 0 };
  await mapLimit(selected, d.concurrency ?? 3, async (c) => {
    try {
      // earlier days from the dated endpoint, today from the intraday one (the dated one never has today); the dated answer must succeed, today's may be empty
      const [dated, today] = await Promise.all([d.get(optionCandlesUrl(c.instrument_key, window.from, window.to)), d.get(optionIntradayUrl(c.instrument_key)).catch(() => null)]);
      const { bars, dropped } = validateBars(mergeBars(parseUpstoxCandles(dated), parseUpstoxCandles(today)));
      const inserted = bars.length ? await d.store.insertCandles(c.instrument_key, bars) : 0;
      summary.fetched++;
      summary.candles += bars.length;
      summary.inserted += inserted;
      summary.dropped += dropped.length;
    } catch {
      summary.failed++;
    }
  });
  return summary;
}

