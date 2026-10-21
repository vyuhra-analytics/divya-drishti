import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { BadRequestException, ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ServerAlertsController } from "./server-alerts.controller";

/** a tiny in-memory stand-in for Postgres: it understands only the statements this controller issues */
function fakeDb(opts: { down?: boolean } = {}) {
  const alerts = new Map<string, any>();
  const kv = new Map<string, string>();
  const sql = (async (strings: TemplateStringsArray, ...v: any[]) => {
    if (opts.down) throw new Error("connection refused");
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.startsWith("SELECT id, alert FROM server_alerts")) return [...alerts].map(([id, alert]) => ({ id, alert }));
    if (q.startsWith("INSERT INTO server_alerts")) return void alerts.set(v[0], JSON.parse(v[1]));
    if (q.startsWith("DELETE FROM server_alerts")) return void alerts.delete(v[0]);
    if (q.startsWith("UPDATE server_alerts SET alert")) return void alerts.set(v[1], JSON.parse(v[0]));
    if (q.startsWith("SELECT value FROM kv")) return kv.has("telegram_chat_id") ? [{ value: kv.get("telegram_chat_id") }] : [];
    if (q.startsWith("INSERT INTO kv")) return void kv.set("telegram_chat_id", v[0]);
    throw new Error(`unexpected SQL: ${q}`);
  }) as any;
  return { db: { sql } as any, alerts, kv };
}

const sent: any[] = [];
let tgUpdates: any = { ok: true, result: [] };
let tgStatus = 200;
const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ALERT_WEBHOOK_URL", "TELEGRAM_API_BASE"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  sent.length = 0;
  tgUpdates = { ok: true, result: [] };
  tgStatus = 200;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/getUpdates")) return tgStatus === 200 ? Response.json(tgUpdates) : new Response("no", { status: tgStatus });
    if (String(url).includes("/sendMessage") || String(url).startsWith("https://hooks.example.com")) {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return tgStatus === 200 ? Response.json({ ok: true }) : new Response("no", { status: tgStatus });
    }
    return new Response("unexpected", { status: 500 });
  }) as never;
});
afterEach(() => {
  for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

const body = { kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: 9500 };

test("add stores a valid rule armed, and refuses an invalid one with a reason", async () => {
  const { db, alerts } = fakeDb();
  const c = new ServerAlertsController(db);
  const a = await c.add(body);
  expect(a).toMatchObject({ kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: 9500, armed: true });
  expect(alerts.size).toBe(1);
  expect((await c.list())[0].id).toBe(a.id);
  await expect(c.add({ kind: "price", symbol: "DOGE", op: "above", value: 1 })).rejects.toBeInstanceOf(BadRequestException);
  await expect(c.add(null)).rejects.toBeInstanceOf(BadRequestException);
  expect(alerts.size).toBe(1); // nothing stored for the bad ones
});

test("at most 50 server alerts", async () => {
  const { db } = fakeDb();
  const c = new ServerAlertsController(db);
  for (let i = 0; i < 50; i++) await c.add({ ...body, value: 9000 + i });
  await expect(c.add(body)).rejects.toBeInstanceOf(ConflictException);
});

test("rearm sets armed and rearmedAt on a fired alert; an unknown id is 404; remove deletes", async () => {
  const { db, alerts } = fakeDb();
  const c = new ServerAlertsController(db);
  const a = await c.add(body);
  alerts.set(a.id, { ...alerts.get(a.id), armed: false, firedAt: 1000 }); // it fired
  await c.rearm(a.id);
  const after = alerts.get(a.id);
  expect(after.armed).toBe(true);
  expect(after.firedAt).toBe(1000); // history kept
  expect(after.rearmedAt).toBeGreaterThan(1000);
  await expect(c.rearm("sa-nope")).rejects.toBeInstanceOf(NotFoundException);
  await c.remove(a.id);
  expect(alerts.size).toBe(0);
});

test("without the database every call says so (503), never a 500", async () => {
  const c = new ServerAlertsController(fakeDb({ down: true }).db);
  for (const call of [() => c.list(), () => c.add(body), () => c.remove("x"), () => c.rearm("x")]) {
    await expect(call()).rejects.toBeInstanceOf(ServiceUnavailableException);
  }
});

test("channels reports what is set up and never the token or the chat id", async () => {
  const { db, kv } = fakeDb();
  const c = new ServerAlertsController(db);
  expect(await c.channels()).toEqual({ telegram: false, telegramLinked: false, webhook: false });
  process.env.TELEGRAM_BOT_TOKEN = "123:SECRET";
  expect(await c.channels()).toEqual({ telegram: true, telegramLinked: false, webhook: false });
  kv.set("telegram_chat_id", "42"); // linked earlier through the panel
  process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/x";
  const r = await c.channels();
  expect(r).toEqual({ telegram: true, telegramLinked: true, webhook: true });
  expect(JSON.stringify(r)).not.toMatch(/SECRET|42|hooks\.example/);
});

test("link needs a token, finds the chat that wrote to the bot, stores it, and says what to do when nobody has", async () => {
  const { db, kv } = fakeDb();
  const c = new ServerAlertsController(db);
  await expect(c.link()).rejects.toThrow(/Set TELEGRAM_BOT_TOKEN/);
  process.env.TELEGRAM_BOT_TOKEN = "123:SECRET";
  await expect(c.link()).rejects.toBeInstanceOf(ConflictException); // nobody has messaged the bot yet
  tgUpdates = { ok: true, result: [{ message: { chat: { id: 777, first_name: "Somu" } } }] };
  expect(await c.link()).toEqual({ linked: true, name: "Somu" });
  expect(kv.get("telegram_chat_id")).toBe("777");
  tgStatus = 401;
  const err = await c.link().catch((e) => e);
  expect(err).toBeInstanceOf(ServiceUnavailableException);
  expect(err.message).not.toContain("SECRET"); // the token never reaches the response
});

test("test needs a channel, sends one message to each that is set up, and is rate limited", async () => {
  const { db } = fakeDb();
  const c = new ServerAlertsController(db);
  await expect(c.test()).rejects.toBeInstanceOf(ConflictException); // nothing set up
  process.env.TELEGRAM_BOT_TOKEN = "123:SECRET";
  process.env.TELEGRAM_CHAT_ID = "42";
  process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/x";
  const r = await c.test();
  expect(r.results).toEqual([
    { channel: "telegram", ok: true },
    { channel: "webhook", ok: true },
  ]);
  expect(sent.map((s) => s.body.chat_id ?? s.body.source)).toEqual(["42", "divya-drishti"]);
  // a Telegram failure is reported per channel, token scrubbed
  tgStatus = 500;
  const bad = await c.test();
  expect(bad.results.every((x) => !x.ok)).toBe(true);
  expect(JSON.stringify(bad)).not.toContain("SECRET");
  // 5 a minute: the 6th is refused
  await c.test();
  await c.test();
  const limited = await c.test().catch((e) => e);
  expect(limited).toBeInstanceOf(HttpException);
  expect(limited.getStatus()).toBe(429);
});
