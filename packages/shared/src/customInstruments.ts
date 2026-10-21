import { INSTRUMENTS, type Instrument } from "./index";

export const MAX_CUSTOM_INSTRUMENTS = 20;
const LOT = /^\d+(\.\d+)? [A-Za-z]{1,12}$/; // "100 bbl": units per lot first, which the cost and paper-trading code parse

/**
 * Validate what the "Add instrument" form sends and build the full catalogue entry. Only MCX and NYMEX energy futures: the exchange
 * decides the time zone, currency, delay and feeds, so none of those can be typed in wrongly. Pure; a function, not a top-level read,
 * because index.ts re-exports this module (see curve.ts).
 */
export function parseCustomInstrument(body: unknown, existing: Instrument[] = INSTRUMENTS): { instrument: Instrument } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  const exchange = b.exchange;
  if (exchange !== "MCX" && exchange !== "NYMEX") return { error: "exchange must be MCX or NYMEX" };
  const root = str("root").toUpperCase();
  if (!/^[A-Z0-9]{1,16}$/.test(root)) return { error: "root must be 1 to 16 letters or digits, e.g. ZINC or RB" };
  const symbol = `${exchange}:${root}`;
  if (existing.some((i) => i.symbol === symbol)) return { error: `${symbol} is already tracked` };
  if (existing.filter((i) => i.custom).length >= MAX_CUSTOM_INSTRUMENTS) return { error: `at most ${MAX_CUSTOM_INSTRUMENTS} added instruments` };
  const name = str("name");
  if (name.length < 2 || name.length > 40 || /[<>]/.test(name)) return { error: "name must be 2 to 40 characters" };
  const decimals = Number(b.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) return { error: "decimals must be a whole number from 0 to 4" };
  const lot = str("lot");
  if (!LOT.test(lot)) return { error: 'lot must be units then a unit, e.g. "100 bbl"' };
  const topic = b.topic;
  if (topic !== "crude" && topic !== "natgas") return { error: "topic must be crude or natgas (it picks the news shown beside the symbol)" };

  if (exchange === "MCX") {
    const upstox = (str("upstox") || root).toUpperCase();
    if (!/^[A-Z0-9]{2,16}$/.test(upstox)) return { error: "Upstox underlying must be 2 to 16 letters or digits" };
    const tv = (str("tv") || `MCX:${root}`).toUpperCase();
    if (!/^MCX:[A-Z0-9]{2,16}$/.test(tv)) return { error: "TradingView root must look like MCX:ZINC" };
    return { instrument: { symbol, name, exchange, currency: "INR", timeZone: "Asia/Kolkata", decimals, topic, lot, delayedBy: 0, sources: ["upstox", "tradingview"], upstox, tv, custom: true } };
  }
  const yahoo = (str("yahoo") || `${root}=F`).toUpperCase();
  if (!/^[A-Z0-9]{1,8}=F$/.test(yahoo)) return { error: "Yahoo symbol must look like RB=F" };
  const tv = (str("tv") || `NYMEX:${root}1!`).toUpperCase();
  if (!/^NYMEX:[A-Z0-9]{1,6}1!$/.test(tv)) return { error: "TradingView root must look like NYMEX:RB1!" };
  return { instrument: { symbol, name, exchange, currency: "USD", timeZone: "America/New_York", decimals, topic, lot, delayedBy: 600, sources: ["yahoo", "tradingview"], yahoo, tv, custom: true } };
}
