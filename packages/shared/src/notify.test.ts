import { expect, test } from "bun:test";
import type { FetchIO } from "./fetcher";
import { channelsOf, deliver, discoverChatId, escapeHtml, scrub, telegramText, type AlertNotice } from "./notify";

const notice: AlertNotice = { id: "a1", rule: "MCX:CRUDEOIL above 9500", message: "MCX:CRUDEOIL: 9503 (above 9500)", at: 1 };

/** a fake network recording every request; `plan` decides each response */
function fake(plan: (url: string, n: number) => Response | Error) {
  const calls: { url: string; body?: any }[] = [];
  const io: FetchIO = {
    env: {},
    now: () => 0,
    fetch: (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      const r = plan(url, calls.length);
      if (r instanceof Error) throw r;
      return r;
    }) as never,
  };
  return { io, calls };
}

test("telegramText escapes anything from the internet", () => {
  expect(escapeHtml(`<b>x</b> & "y"`)).toBe(`&lt;b&gt;x&lt;/b&gt; &amp; "y"`);
  const t = telegramText({ ...notice, message: "Reuters: <script>alert(1)</script> & more" });
  expect(t).toContain("&lt;script&gt;");
  expect(t).not.toContain("<script>");
  expect(t.startsWith("<b>Divya Drishti alert</b>")).toBe(true);
});

test("deliver sends to Telegram and the webhook, with the chat id and the message", async () => {
  const { io, calls } = fake(() => new Response("{}"));
  const r = await deliver(notice, { telegramToken: "123:ABC", telegramChatId: "42", webhookUrl: "https://hooks.example.com/x" }, io);
  expect(r).toEqual([{ channel: "telegram", ok: true }, { channel: "webhook", ok: true }]);
  expect(calls[0].url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
  expect(calls[0].body).toMatchObject({ chat_id: "42", parse_mode: "HTML" });
  expect(calls[0].body.text).toContain("9503");
  expect(calls[1].url).toBe("https://hooks.example.com/x");
  expect(calls[1].body).toEqual({ source: "divya-drishti", id: "a1", rule: "MCX:CRUDEOIL above 9500", message: "MCX:CRUDEOIL: 9503 (above 9500)", at: 1 });
});

test("a channel that is not set up is skipped; Telegram needs both a token and a chat", async () => {
  const { io, calls } = fake(() => new Response("{}"));
  expect(await deliver(notice, {}, io)).toEqual([]);
  expect(await deliver(notice, { telegramToken: "t" }, io)).toEqual([]); // no chat linked yet
  expect(calls).toHaveLength(0);
  expect(channelsOf({ telegramToken: "t" })).toEqual({ telegram: true, telegramLinked: false, webhook: false });
  expect(channelsOf({ telegramToken: "t", telegramChatId: "1", webhookUrl: "u" })).toEqual({ telegram: true, telegramLinked: true, webhook: true });
});

test("one dropped connection is retried; a failing channel never stops the other and never leaks the token", async () => {
  let n = 0;
  const flaky = fake(() => (n++ === 0 ? new Error("socket hang up") : new Response("{}")));
  expect((await deliver(notice, { telegramToken: "123:SECRET", telegramChatId: "1" }, flaky.io))[0]).toEqual({ channel: "telegram", ok: true });
  expect(flaky.calls).toHaveLength(2);

  const down = fake((url) => (url.includes("api.telegram.org") ? new Error(`fetch failed for ${url}`) : new Response("{}")));
  const r = await deliver(notice, { telegramToken: "123:SECRET", telegramChatId: "1", webhookUrl: "https://hooks.example.com/x" }, down.io);
  expect(r[0]).toMatchObject({ channel: "telegram", ok: false });
  expect(r[0].error).not.toContain("SECRET");
  expect(r[0].error).toContain("***");
  expect(r[1]).toEqual({ channel: "webhook", ok: true });

  const bad = fake(() => new Response("no", { status: 401 }));
  expect((await deliver(notice, { telegramToken: "t", telegramChatId: "1" }, bad.io))[0]).toEqual({ channel: "telegram", ok: false, error: "HTTP 401" });
});

test("a fake Telegram base URL is honoured", async () => {
  const { io, calls } = fake(() => new Response("{}"));
  await deliver(notice, { telegramToken: "t", telegramChatId: "1", telegramBase: "http://127.0.0.1:9999" }, io);
  expect(calls[0].url).toBe("http://127.0.0.1:9999/bott/sendMessage");
});

test("discoverChatId takes the newest chat that wrote to the bot", async () => {
  const updates = { ok: true, result: [{ message: { chat: { id: 111, first_name: "Old" } } }, { message: { chat: { id: 222, username: "somu" } } }] };
  const { io, calls } = fake(() => Response.json(updates));
  expect(await discoverChatId("tok", io)).toEqual({ chatId: "222", name: "somu" });
  expect(calls[0].url).toBe("https://api.telegram.org/bottok/getUpdates?limit=20");
  expect(await discoverChatId("tok", fake(() => Response.json({ ok: true, result: [] })).io)).toBeUndefined();
  await expect(discoverChatId("tok-SECRET", fake(() => new Response("x", { status: 401 })).io)).rejects.toThrow(/check TELEGRAM_BOT_TOKEN/);
  expect(scrub("failed at /bottok-SECRET/send", "tok-SECRET")).toBe("failed at /bot***/send");
});
