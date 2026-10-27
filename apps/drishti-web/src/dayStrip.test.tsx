import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DayStrip } from "./DayStrip";

const NOW = Date.UTC(2026, 9, 28, 13, 0); // Wed 28 Oct 2026, 18:30 IST: the range hour has started, the US open (19:00 IST) is half an hour away
const PRINT = Date.UTC(2026, 9, 28, 14, 30);

beforeEach(() => setSystemTime(new Date(NOW)));
afterEach(() => {
  cleanup();
  setSystemTime();
});

function serve(events: object[]) {
  globalThis.fetch = mock(async (u: string) => ({ ok: true, status: 200, json: async () => (String(u).includes("series=WPSR") ? events : []) })) as never;
}

test("says what comes next with a countdown and the one after it", async () => {
  serve([]);
  render(<DayStrip />);
  const strip = await screen.findByRole("status", { name: "Next event" });
  expect(strip.textContent).toContain("US open: the USIB range is set in 30m");
  expect(strip.textContent).toContain("then USIB entry window closes");
});

test("a stored EIA print joins the list in time order, and the strip names the print when it is next", async () => {
  serve([{ scheduled_at: new Date(PRINT).toISOString() }]);
  render(<DayStrip />);
  await waitFor(() => expect(screen.getByRole("status", { name: "Next event" }).getAttribute("title")).toContain("EIA print"));
  setSystemTime(new Date(PRINT - 20 * 60_000)); // later: the print is the next thing after the range hour mark
  cleanup();
  render(<DayStrip />);
  await waitFor(() => expect(screen.getByRole("status", { name: "Next event" }).textContent).toContain("EIA print in 20m"));
});
