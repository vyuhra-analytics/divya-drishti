import { BadRequestException, Controller, Get, Header, Query, Redirect } from "@nestjs/common";
import { ACCOUNT_ACCESS_HINT, classifyAccountAccess, upstoxTokenExpiry, type AccountAccess } from "@drishti/shared";
import { Db } from "./db";

// Upstox OAuth: the user logs in on upstox.com; we exchange the one-time code for an access token
// and park it in Redis (`upstox:token`, expiring 03:30 IST) where drishti-core-stream picks it up.
// Secrets come from .env only and never leave this service; the token is never logged or returned.
const { UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_REDIRECT_URI } = process.env;
const configured = () => !!(UPSTOX_API_KEY && UPSTOX_API_SECRET && UPSTOX_REDIRECT_URI);

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px system-ui;background:#131722;color:#d1d4dc;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`;

const ACCOUNT_CACHE_MS = 60_000;
let accountCache: { at: number; access: AccountAccess } | null = null;
/** Tests only: forget the cached account check. */
export const resetAccountCache = () => {
  accountCache = null;
};

@Controller("auth/upstox")
export class UpstoxController {
  constructor(private readonly db: Db) {}

  @Get("login")
  @Redirect()
  async login() {
    if (!configured()) {
      throw new BadRequestException("Set UPSTOX_API_KEY, UPSTOX_API_SECRET and UPSTOX_REDIRECT_URI in .env, then restart the API");
    }
    const state = crypto.randomUUID(); // CSRF guard for the callback
    await this.db.redis.send("SET", [`upstox:state:${state}`, "1", "EX", "600"]);
    const url = new URL("https://api.upstox.com/v2/login/authorization/dialog");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: UPSTOX_API_KEY!,
      redirect_uri: UPSTOX_REDIRECT_URI!,
      state,
    }).toString();
    return { url: url.toString() };
  }

  @Get("callback")
  @Header("Content-Type", "text/html; charset=utf-8")
  async callback(@Query("code") code?: string, @Query("state") state?: string) {
    if (!configured()) return page("Upstox not configured", "Add the Upstox keys to .env first.");
    if (!code || !state || !(await this.db.redis.send("GETDEL", [`upstox:state:${state}`]))) {
      return page("Login expired", "Start again from Settings → Connection → Connect Upstox.");
    }
    const res = await fetch("https://api.upstox.com/v2/login/authorization/token", {
      method: "POST",
      headers: { accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: UPSTOX_API_KEY!,
        client_secret: UPSTOX_API_SECRET!,
        redirect_uri: UPSTOX_REDIRECT_URI!,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      return page("Upstox login failed", `Upstox answered ${res.status}. Try again.`);
    }
    const expiresAt = upstoxTokenExpiry(Date.now());
    await this.db.redis.send("SET", ["upstox:token", json.access_token, "PXAT", String(expiresAt)]);
    return page("Upstox connected", `Live MCX data until ${new Date(expiresAt).toLocaleString()}. You can close this tab.`);
  }

  @Get("status")
  async status() {
    const ttl = Number(await this.db.redis.send("PTTL", ["upstox:token"]).catch(() => -2));
    const envToken = !!process.env.UPSTOX_ACCESS_TOKEN?.trim();
    return {
      configured: configured() || envToken,
      loginConfigured: configured(), // the Connect button needs key/secret/redirect
      connected: ttl > 0 || envToken,
      via: ttl > 0 ? "login" : envToken ? "env" : null,
      expiresAt: ttl > 0 ? Date.now() + ttl : null, // .env tokens: expiry unknown to us (daily or analytics)
    };
  }

  /**
   * Can this app read your Upstox account (positions, funds, orders, trades)? Upstox answers those only from the static IP registered in
   * the Upstox app, so a working token alone is not enough. Asks for the profile (cached 60 s) and returns only the verdict and what to do:
   * nothing from the profile itself is returned or stored. GET /auth/upstox/account
   */
  @Get("account")
  async account(): Promise<{ access: AccountAccess; hint: string }> {
    const done = (access: AccountAccess) => ({ access, hint: ACCOUNT_ACCESS_HINT[access] });
    if (accountCache && Date.now() - accountCache.at < ACCOUNT_CACHE_MS) return done(accountCache.access);
    const token = (await this.db.redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim();
    if (!token) return done("no_token");
    let access: AccountAccess = "unavailable";
    try {
      const res = await fetch("https://api.upstox.com/v2/user/profile", { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      access = classifyAccountAccess(res.status, await res.json().catch(() => null));
    } catch {
      access = "unavailable";
    }
    accountCache = { at: Date.now(), access };
    return done(access);
  }
}
