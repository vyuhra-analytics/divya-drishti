// Alert delivery: Telegram and a generic webhook. The bot token only ever travels in the request URL to Telegram; it is scrubbed from
// every error message and never returned or logged. `fetch` is injected (FetchIO), so tests use a fake Telegram.
import type { FetchIO } from "./fetcher";

export interface NotifyConfig {
  /** from TELEGRAM_BOT_TOKEN */
  telegramToken?: string;
  /** from TELEGRAM_CHAT_ID or discovered with `discoverChatId` and stored */
  telegramChatId?: string;
  /** from ALERT_WEBHOOK_URL: a URL you own, never taken from the browser */
  webhookUrl?: string;
  /** testing hook: a fake Telegram (TELEGRAM_API_BASE); defaults to the real one */
  telegramBase?: string;
}

export interface Delivery {
  channel: "telegram" | "webhook";
  ok: boolean;
  error?: string;
}

const TELEGRAM = "https://api.telegram.org";

/** Remove the bot token from any text (error messages carry the request URL). */
export const scrub = (text: string, token?: string) => (token ? text.split(token).join("***") : text);

/** Escape for Telegram's HTML parse mode (the message may carry headline text from the internet). */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface AlertNotice {
  id: string;
  /** what the alert is, for the title: "MCX:CRUDEOIL above 9500" */
  rule: string;
  /** what happened: "MCX:CRUDEOIL: 9503 (above 9500)" */
  message: string;
  at: number;
}

export const telegramText = (n: AlertNotice) => `<b>Divya Drishti alert</b>\n${escapeHtml(n.message)}\n<i>${escapeHtml(n.rule)}</i>`;

/** Channels that are set up, for status displays: which will receive an alert. */
export function channelsOf(c: NotifyConfig): { telegram: boolean; telegramLinked: boolean; webhook: boolean } {
  return { telegram: !!c.telegramToken, telegramLinked: !!c.telegramToken && !!c.telegramChatId, webhook: !!c.webhookUrl };
}

/** Send one alert to every configured channel. One channel failing never stops the other; failures come back, never throw. */
export async function deliver(n: AlertNotice, c: NotifyConfig, io: FetchIO): Promise<Delivery[]> {
  const out: Delivery[] = [];
  if (c.telegramToken && c.telegramChatId) {
    out.push(await post("telegram", `${c.telegramBase ?? TELEGRAM}/bot${c.telegramToken}/sendMessage`, { chat_id: c.telegramChatId, text: telegramText(n), parse_mode: "HTML", disable_web_page_preview: true }, c.telegramToken, io));
  }
  if (c.webhookUrl) out.push(await post("webhook", c.webhookUrl, { source: "divya-drishti", id: n.id, rule: n.rule, message: n.message, at: n.at }, undefined, io));
  return out;
}

async function post(channel: Delivery["channel"], url: string, body: unknown, token: string | undefined, io: FetchIO): Promise<Delivery> {
  const attempt = async () => {
    const res = await io.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };
  try {
    try {
      await attempt();
    } catch {
      await attempt(); // one retry: a dropped connection should not lose an alert
    }
    return { channel, ok: true };
  } catch (e) {
    return { channel, ok: false, error: scrub((e as Error).message, token) };
  }
}

/**
 * Find the chat to send to: the most recent chat that messaged the bot. The user opens the bot in Telegram, sends it any message,
 * then asks us to link. Returns undefined when nobody has written to it yet.
 */
export async function discoverChatId(token: string, io: FetchIO, base = TELEGRAM): Promise<{ chatId: string; name: string } | undefined> {
  const res = await io.fetch(`${base}/bot${token}/getUpdates?limit=20`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(scrub(`Telegram answered HTTP ${res.status}: check TELEGRAM_BOT_TOKEN`, token));
  const json: any = await res.json();
  const updates: any[] = json?.result ?? [];
  for (const u of updates.slice().reverse()) {
    const chat = u?.message?.chat ?? u?.channel_post?.chat;
    if (chat?.id !== undefined) return { chatId: String(chat.id), name: chat.title ?? chat.username ?? chat.first_name ?? String(chat.id) };
  }
  return undefined;
}

/** Channel settings from the environment, plus the Telegram chat id the user linked (stored in the database) when TELEGRAM_CHAT_ID is not set. */
export async function buildNotifyConfig(env: Record<string, string | undefined>, storedChatId: () => Promise<string | undefined>): Promise<NotifyConfig> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  return {
    telegramToken: token,
    telegramChatId: token ? env.TELEGRAM_CHAT_ID?.trim() || (await storedChatId().catch(() => undefined)) : undefined,
    webhookUrl: env.ALERT_WEBHOOK_URL?.trim() || undefined,
    telegramBase: env.TELEGRAM_API_BASE?.trim() || undefined,
  };
}
