import { useEffect, useState } from "react";
import { eveningEvents, inText } from "@drishti/shared";
import { apiUrl, useClock } from "./settings";
import { useNow, useSessions } from "./market";

/**
 * One line in the top bar on every desk: what comes next and when (the USIB range and open, the EIA print and its marks, the MCX close), with a countdown and
 * the one after it. From the clocks and the stored calendar; nothing is estimated. The countdown ticks every second.
 */
export function DayStrip() {
  const now = useNow(1000);
  const clock = useClock();
  const sessions = useSessions();
  const [printAt, setPrintAt] = useState<number | undefined>(undefined);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      const day = 86_400_000;
      const q = `from=${new Date(Date.now() - day).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 3 * day).toISOString().slice(0, 10)}`;
      try {
        const all = (await Promise.all((["WPSR", "WNGSR"] as const).map((s) => fetch(`${apiUrl()}/calendar/stored?${q}&series=${s}`, { signal: ctrl.signal }).then((r) => (r.ok ? r.json() : []))))).flat() as { scheduled_at: string }[];
        const next = all.map((e) => Date.parse(e.scheduled_at)).filter((t) => Number.isFinite(t) && t > Date.now() - 3 * 3600_000).sort((a, b) => a - b)[0];
        setPrintAt(next);
      } catch {
        /* the strip works from the clocks alone until the next try */
      }
    };
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, []);

  const mcx = sessions.MCX;
  const events = eveningEvents(now, { printAt, mcxCloseAt: mcx.open ? mcx.next : undefined });
  const [a, b] = events;
  if (!a) return null;
  return (
    <span className="daystrip" role="status" aria-label="Next event" title={events.slice(0, 6).map((e) => `${clock.time(e.at)}  ${e.label}`).join("\n")}>
      <b>{a.label}</b> {inText(a.at - now)} <span className="muted">({clock.time(a.at)})</span>
      {b && (
        <span className="muted">
          {" "}· then {b.label} {clock.time(b.at)}
        </span>
      )}
    </span>
  );
}
