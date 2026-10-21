import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Alert } from "@drishti/shared";

export interface Fired {
  id: string;
  alertId: string;
  at: number;
  message: string;
}

interface AlertsState {
  alerts: Alert[];
  /** newest first, last 50 */
  history: Fired[];
  /** transient on-screen notices */
  toasts: Fired[];
  add: (a: Omit<Alert, "id" | "armed">) => void;
  remove: (id: string) => void;
  rearm: (id: string) => void;
  /** engine writes back the evaluated alert */
  update: (a: Alert) => void;
  push: (alertId: string, message: string) => void;
  dismiss: (id: string) => void;
}

export const MAX_ALERTS = 50;

export const useAlerts = create<AlertsState>()(
  persist(
    (set, get) => ({
      alerts: [],
      history: [],
      toasts: [],
      add: (a) => {
        if (get().alerts.length >= MAX_ALERTS) return;
        set((s) => ({ alerts: [...s.alerts, { ...a, id: `al-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, armed: true }] }));
      },
      remove: (id) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),
      rearm: (id) => set((s) => ({ alerts: s.alerts.map((a) => (a.id === id ? { ...a, armed: true, firedAt: undefined } : a)) })),
      update: (a) => set((s) => ({ alerts: s.alerts.map((x) => (x.id === a.id ? a : x)) })),
      push: (alertId, message) => {
        const f: Fired = { id: `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, alertId, at: Date.now(), message };
        set((s) => ({ history: [f, ...s.history].slice(0, 50), toasts: [...s.toasts, f] }));
      },
      dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    }),
    { name: "drishti-alerts", version: 1, partialize: ({ alerts, history }) => ({ alerts, history }) },
  ),
);
