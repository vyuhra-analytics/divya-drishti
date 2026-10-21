import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpException, NotFoundException, Param, Post, ServiceUnavailableException } from "@nestjs/common";
import { buildNotifyConfig, channelsOf, deliver, discoverChatId, MAX_SERVER_ALERTS, parseAlertInput, RateLimiter, scrub, type Alert } from "@drishti/shared";
import { Db } from "./db";

const testLimiter = new RateLimiter(5, 60_000); // test messages go to a real chat: never more than 5 a minute
const io = { fetch: (input: string | URL, init?: RequestInit) => fetch(input, init), env: process.env, now: Date.now };

/**
 * Server-side alerts: rules stored in Postgres and evaluated by the stream service, so they fire while the app is closed and are
 * delivered to Telegram and/or a webhook. The bot token and webhook URL come only from .env and are never returned.
 * GET /alerts, POST /alerts, DELETE /alerts/:id, POST /alerts/:id/rearm, GET /alerts/channels, POST /alerts/telegram/link, POST /alerts/test
 */
@Controller("alerts")
export class ServerAlertsController {
  constructor(private readonly db: Db) {}

  private async rows(): Promise<Alert[]> {
    try {
      const rows = await this.db.sql`SELECT id, alert FROM server_alerts ORDER BY created_at`;
      return (rows as { id: string; alert: Alert }[]).map((r) => ({ ...r.alert, id: r.id }));
    } catch {
      throw new ServiceUnavailableException("Server alerts need the database (bun run infra:up)");
    }
  }

  private config() {
    return buildNotifyConfig(process.env, async () => {
      const r = (await this.db.sql`SELECT value FROM kv WHERE key = 'telegram_chat_id'`) as { value: string }[];
      return r[0]?.value;
    });
  }

  @Get()
  list() {
    return this.rows();
  }

  @Post()
  async add(@Body() body: unknown) {
    const parsed = parseAlertInput(body);
    if ("error" in parsed) throw new BadRequestException(parsed.error);
    if ((await this.rows()).length >= MAX_SERVER_ALERTS) throw new ConflictException(`At most ${MAX_SERVER_ALERTS} server alerts`);
    const alert: Alert = { ...parsed.alert, id: `sa-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, armed: true };
    const { id, ...rest } = alert;
    await this.db.sql`INSERT INTO server_alerts (id, alert) VALUES (${id}, ${JSON.stringify(rest)}::text::jsonb)`; // ::text first: Bun would send a JSON string
    return alert;
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    await this.rows(); // 503 without a database
    await this.db.sql`DELETE FROM server_alerts WHERE id = ${id}`;
    return { ok: true };
  }

  /** Arm a fired price/change alert again. `rearmedAt` makes it win over the engine's own copy of the fired state. */
  @Post(":id/rearm")
  async rearm(@Param("id") id: string) {
    const a = (await this.rows()).find((x) => x.id === id);
    if (!a) throw new NotFoundException("No such alert");
    const { id: _id, ...rest } = { ...a, armed: true, rearmedAt: Date.now() };
    await this.db.sql`UPDATE server_alerts SET alert = ${JSON.stringify(rest)}::text::jsonb WHERE id = ${id}`;
    return { ok: true };
  }

  @Get("channels")
  async channels() {
    return channelsOf(await this.config().catch(() => buildNotifyConfig(process.env, async () => undefined)));
  }

  /** After the user sent the bot any message in Telegram: remember that chat as the destination. */
  @Post("telegram/link")
  async link() {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) throw new ServiceUnavailableException("Set TELEGRAM_BOT_TOKEN in .env (create a bot with @BotFather in Telegram)");
    let found;
    try {
      found = await discoverChatId(token, io, process.env.TELEGRAM_API_BASE?.trim() || undefined);
    } catch (e) {
      throw new ServiceUnavailableException(scrub((e as Error).message, token));
    }
    if (!found) throw new ConflictException("Open your bot in Telegram and send it any message, then link again");
    await this.db.sql`INSERT INTO kv (key, value) VALUES ('telegram_chat_id', ${found.chatId}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    return { linked: true, name: found.name };
  }

  @Post("test")
  async test() {
    if (!testLimiter.take("test")) throw new HttpException("Too many test messages: wait a minute", 429);
    const cfg = await this.config();
    const results = await deliver({ id: "test", rule: "test", message: "Test alert from Divya Drishti: delivery works.", at: Date.now() }, cfg, io);
    if (results.length === 0) throw new ConflictException("No channel is set up: add TELEGRAM_BOT_TOKEN (and link the chat) and/or ALERT_WEBHOOK_URL in .env");
    return { results };
  }
}
