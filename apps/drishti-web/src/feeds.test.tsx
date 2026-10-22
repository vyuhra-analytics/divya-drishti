import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Feeds } from "./Feeds";

// Settings -> Data feeds: the Upstox line and the account-access line under it, from fake API answers.
const answer = (account: object | null, upstox: object = { configured: true, loginConfigured: false, via: "env", connected: true, expiresAt: null }) => {
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    if (u.includes("/auth/upstox/status")) return { ok: true, json: async () => upstox };
    if (u.includes("/auth/upstox/account")) return account ? { ok: true, json: async () => account } : { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ feed: "live", providers: {}, active: {} }) };
  }) as never;
};
afterEach(cleanup);

test("a token that cannot read the account says it needs the static IP registered in Upstox", async () => {
  answer({ access: "static_ip", hint: "Upstox answers account reads only from the static IP registered in your Upstox app (error UDAPI1221). Register this machine's public IP there." });
  render(<Feeds />);
  await waitFor(() => expect(screen.getByText(/UDAPI1221/)).toBeTruthy());
  expect(screen.getByText("needs static IP")).toBeTruthy();
});

test("readable account access shows as readable, a refused token as refused", async () => {
  answer({ access: "ok", hint: "Upstox lets this app read your account (positions, funds, orders, trades)." });
  render(<Feeds />);
  await waitFor(() => expect(screen.getByText("readable")).toBeTruthy());
  cleanup();
  answer({ access: "token", hint: "Upstox refused the account read: the token may be expired." });
  render(<Feeds />);
  await waitFor(() => expect(screen.getByText("refused")).toBeTruthy());
});

test("with Upstox not connected the account line is not shown, and an unreachable API shows unavailable", async () => {
  answer({ access: "no_token", hint: "Not connected to Upstox." }, { configured: false, loginConfigured: false, via: null, connected: false, expiresAt: null });
  render(<Feeds />);
  await waitFor(() => expect(screen.getByText(/add UPSTOX_ACCESS_TOKEN/)).toBeTruthy());
  expect(screen.queryByText("Upstox account (positions, funds, trades)", { exact: false })).toBeNull();
  cleanup();
  answer(null);
  render(<Feeds />);
  await waitFor(() => expect(screen.getByText("unavailable")).toBeTruthy());
});
