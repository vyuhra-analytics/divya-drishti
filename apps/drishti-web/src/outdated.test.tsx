import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Outdated } from "./Outdated";

afterEach(cleanup);
const NOW = Date.UTC(2026, 9, 21);
const DAY = 86_400_000;

test("nothing is shown while the data is inside its freshness budget", () => {
  const { container } = render(<Outdated kind="positioning" asOf={NOW - 10 * DAY} now={NOW} />);
  expect(container.textContent).toBe("");
});

test("data older than its budget is marked OUTDATED with how old it is and what is normal", () => {
  render(<Outdated kind="positioning" asOf={NOW - 14 * DAY} now={NOW} />);
  const badge = screen.getByText("OUTDATED");
  expect(badge.getAttribute("title")).toContain("14 days old");
  expect(badge.getAttribute("title")).toContain("no older than 12 days");
});

test("each kind has its own budget: India's JODI month is fine at 200 days, the same age fails for a weekly report", () => {
  const { container } = render(<Outdated kind="balances" asOf={NOW - 200 * DAY} now={NOW} />);
  expect(container.textContent).toBe("");
  cleanup();
  render(<Outdated kind="inventory" asOf={NOW - 200 * DAY} now={NOW} />);
  expect(screen.getByText("OUTDATED")).toBeTruthy();
});
