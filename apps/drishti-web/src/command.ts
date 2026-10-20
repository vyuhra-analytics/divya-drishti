import type { WidgetType } from "./workspace";

/** Bloomberg-style function mnemonics. */
export const MNEMONICS: Record<string, WidgetType> = { GP: "chart", Q: "quote", W: "watchlist", TV: "tv" };

export interface Command {
  symbol?: string;
  open?: WidgetType;
}

export type ParseResult = { ok: true; cmd: Command } | { ok: false; error: string; suggestions: string[] };

/** Symbols matching a partial token: prefix matches first, then substring matches. */
export function suggest(token: string, symbols: readonly string[]): string[] {
  const t = token.toUpperCase();
  if (!t) return [...symbols];
  const prefix = symbols.filter((s) => s.startsWith(t));
  return [...prefix, ...symbols.filter((s) => !s.startsWith(t) && s.includes(t))];
}

/** "TCS" load symbol · "TCS GP" open chart on TCS · "GP" open chart on focused symbol. Order-free, case-insensitive. */
export function parse(input: string, symbols: readonly string[]): ParseResult {
  const tokens = input.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ok: false, error: "type a symbol or command", suggestions: [...symbols] };

  const cmd: Command = {};
  for (const tok of tokens) {
    if (!cmd.open && tok in MNEMONICS) cmd.open = MNEMONICS[tok];
    else if (!cmd.symbol && symbols.includes(tok)) cmd.symbol = tok;
    else return { ok: false, error: `unknown "${tok}"`, suggestions: suggest(tok, symbols) };
  }
  return { ok: true, cmd };
}
