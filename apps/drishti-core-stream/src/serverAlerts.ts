import type { SQL } from "bun";
import { buildNotifyConfig, deliver, RateLimiter, scrub, ServerAlertEngine, type Alert, type CalEvent, type NewsItem } from "@drishti/shared";

const REFRESH_MS = 10_000; // pick up added, deleted and re-armed alerts
const TICK_MS = 30_000; // release alerts
const API = `http://127.0.0.1:${process.env.API_PORT ?? 3001}`;
const FRESH_NEWS_MS = 15 * 60_000; // the stream replays its backlog on start: only headlines under 15 minutes old can be news worth an alert
const out = new RateLimiter(20, 60_000); // never more than 20 outgoing messages a minute: a runaway rule must not flood a chat

const io = { fetch: (input: string | URL, init?: RequestInit) => fetch(input, init), env: process.env, now: Date.now };

/**
 * Server-side alerts (R22): rules live in Postgres `server_alerts`; this evaluates them on every live quote, new headline and a 30 s
 * timer, saves the fired state, then delivers to Telegram / the webhook and publishes {type:"alert"} on the WS topic `alerts` so open
 * browsers can show a toast. Without a database it just stays idle.
 */
export function startServerAlerts(sql: SQL, publish: (json: string) => void, quotes: () => Record<string, { price: number; prevClose?: number }>) {
  let events: { at: number; list: CalEvent[] } = { at: 0, list: [] };
  let warned = false;
  const config = () =>
    buildNotifyConfig(process.env, async () => {
      const r = (await sql`SELECT value FROM kv WHERE key = 'telegram_chat_id'`) as { value: string }[];
      return r[0]?.value;
    });

  const engine = new ServerAlertEngine({
    load: async () => ((await sql`SELECT id, alert FROM server_alerts ORDER BY created_at`) as { id: string; alert: Alert }[]).map((r) => ({ ...r.alert, id: r.id })),
    save: async (a) => {
      const { id, ...rest } = a;
      await sql`UPDATE server_alerts SET alert = ${JSON.stringify(rest)}::text::jsonb WHERE id = ${id}`; // ::text first: Bun sends a JSON string otherwise
    },
    notify: async (n) => {
      publish(JSON.stringify({ type: "alert", id: n.id, message: n.message, rule: n.rule, at: n.at }));
      if (!out.take("out")) return console.warn("server alerts: outgoing limit reached, message not sent to Telegram/webhook");
      try {
        const cfg = await config();
        for (const r of await deliver(n, cfg, io)) if (!r.ok) console.warn(`server alert ${n.id}: ${r.channel} delivery failed: ${scrub(r.error ?? "", cfg.telegramToken)}`);
      } catch (e) {
        console.warn(`server alert ${n.id}: delivery error: ${(e as Error).message}`);
      }
    },
    events: async () => {
      if (Date.now() - events.at < 10 * 60_000) return events.list;
      try {
        const res = await fetch(`${API}/calendar?days=2`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) events = { at: Date.now(), list: (await res.json()) as CalEvent[] };
      } catch {
        /* API not up yet: release alerts wait */
      }
      return events.list;
    },
    now: Date.now,
  });

  const guarded = (label: string, fn: () => Promise<void>) =>
    fn().catch((e) => {
      if (!warned) console.warn(`server alerts idle (${label}): ${(e as Error).message}`);
      warned = true;
    });
  void guarded("load", () => engine.refresh());
  const timers = [setInterval(() => void guarded("refresh", () => engine.refresh()), REFRESH_MS), setInterval(() => void guarded("release check", () => engine.tick()), TICK_MS)];

  return {
    /** call after every accepted quote */
    onQuotes: () => (engine.size ? void guarded("quotes", () => engine.onQuotes(quotes())) : undefined),
    /** call with headlines that were just added */
    onNews: (fresh: NewsItem[]) => void guarded("news", () => engine.onNews(fresh.filter((n) => n.publishedAt > Date.now() - FRESH_NEWS_MS))),
    stop: () => timers.forEach(clearInterval),
  };
}
