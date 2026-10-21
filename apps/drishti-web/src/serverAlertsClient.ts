import { useCallback, useEffect, useState } from "react";
import type { Alert } from "@drishti/shared";
import { apiUrl } from "./settings";

export interface Channels {
  telegram: boolean;
  telegramLinked: boolean;
  webhook: boolean;
}

async function call(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${apiUrl()}/alerts${path}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
  return json;
}

/** Alerts kept on the server (they fire with the app closed and go to Telegram or a webhook), with the delivery channels that are set up. */
export function useServerAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [channels, setChannels] = useState<Channels | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAlerts(await call(""));
      setChannels(await call("/channels"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  };

  return {
    alerts,
    channels,
    error,
    add: (a: Omit<Alert, "id" | "armed">) => act(() => call("", "POST", a)),
    remove: (id: string) => act(() => call(`/${encodeURIComponent(id)}`, "DELETE")),
    rearm: (id: string) => act(() => call(`/${encodeURIComponent(id)}/rearm`, "POST")),
    /** after messaging the bot in Telegram */
    link: async () => {
      try {
        const r = await call("/telegram/link", "POST");
        await load();
        return `Linked to ${r.name}`;
      } catch (e) {
        return (e as Error).message;
      }
    },
    /** sends one real message to the linked chat and/or the webhook */
    test: async () => {
      try {
        const r = await call("/test", "POST");
        return (r.results as { channel: string; ok: boolean; error?: string }[]).map((x) => `${x.channel}: ${x.ok ? "sent" : `failed (${x.error})`}`).join(", ");
      } catch (e) {
        return (e as Error).message;
      }
    },
  };
}
