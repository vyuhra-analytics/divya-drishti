// Why Upstox's account endpoints (positions, funds, orders, trades, P&L) answer or refuse. Market data works with any valid token, but the account
// endpoints answer only from the static IP registered in the Upstox app (SEBI's retail algo rules): a 401 `UDAPI1221`. Telling that apart from a
// bad or expired token says what to do about it. Pure, tested against the real response shape.

export type AccountAccess =
  /** the account endpoints answer: positions, funds, orders and trades can be read */
  | "ok"
  /** refused because this machine's IP is not the one registered in the Upstox app (UDAPI1221) */
  | "static_ip"
  /** refused for another reason that points at the token (401 or 403): expired, revoked, or without portfolio rights */
  | "token"
  /** no token at all */
  | "no_token"
  /** Upstox did not answer sensibly (network, 5xx, an unknown shape) */
  | "unavailable";

/** One account-endpoint response → what it means. `json` is the parsed body or null when it could not be parsed. */
export function classifyAccountAccess(status: number, json: any): AccountAccess {
  if (status >= 200 && status < 300) return json?.status === "success" || json?.data !== undefined ? "ok" : "unavailable";
  const codes: string[] = (Array.isArray(json?.errors) ? json.errors : []).map((e: any) => String(e?.errorCode ?? e?.error_code ?? ""));
  if (codes.includes("UDAPI1221")) return "static_ip";
  if (status === 401 || status === 403) return "token";
  return "unavailable";
}

/** What to tell the owner, one sentence each. */
export const ACCOUNT_ACCESS_HINT: Record<AccountAccess, string> = {
  ok: "Upstox lets this app read your account (positions, funds, orders, trades).",
  static_ip: "Upstox answers account reads only from the static IP registered in your Upstox app (error UDAPI1221). Register this machine's public IP there, or run the API from a server with a fixed address.",
  token: "Upstox refused the account read: the token may be expired or without portfolio rights. Log in again from Settings → Data feeds.",
  no_token: "Not connected to Upstox.",
  unavailable: "Upstox did not answer the account check.",
};
