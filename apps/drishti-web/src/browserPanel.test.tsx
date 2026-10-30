import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserWidget } from "./BrowserPanel";
import { useWorkspace, type Widget } from "./workspace";

// The browser panel: in a plain tab it shows the page in an iframe; in the desktop app it opens a native child webview over its own rectangle, follows the
// panel, and drives it with one fixed command. The Tauri modules are faked here: what is checked is what the panel asks of them.

const calls: { op: string; args?: unknown[] }[] = [];
const rec = (op: string, ...args: unknown[]) => void calls.push({ op, args });

class FakeWebview {
  static byLabel: FakeWebview | null = null;
  window = {};
  constructor(public label: string) {}
  static getByLabel = async () => FakeWebview.byLabel;
  once = async (event: string, cb: (e: unknown) => void) => {
    if (event === "tauri://created") queueMicrotask(() => cb({}));
    return () => {};
  };
  close = async () => rec("close", this.label);
  hide = async () => rec("hide");
  show = async () => rec("show");
  setPosition = async (p: { x: number; y: number }) => rec("position", p.x, p.y);
  setSize = async (s: { width: number; height: number }) => rec("size", s.width, s.height);
}
mock.module("@tauri-apps/api/webview", () => ({ Webview: FakeWebview }));
mock.module("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
mock.module("@tauri-apps/api/core", () => ({
  SERIALIZE_TO_IPC_FN: "__TAURI_TO_IPC_KEY__",
  invoke: async (cmd: string, args: { label: string }) => {
    rec(`invoke:${cmd}`, args);
    if (cmd !== "browser_open") return undefined;
    FakeWebview.byLabel = new FakeWebview(args.label); // the Rust side creates the view; the web app then finds it by its label
    return { extensions_dir: "C:/Users/me/AppData/Roaming/dev.divyadrishti.terminal/extensions", extensions: 2 };
  },
}));

const ID = "bw";
let box = { left: 100, top: 100, width: 400, height: 300 };
const realRect = HTMLElement.prototype.getBoundingClientRect;

const put = (url?: string) => useWorkspace.setState({ widgets: [{ id: ID, type: "browser", group: null, symbol: "MCX:CRUDEOIL", tf: "5m", ...(url ? { url } : {}) } as Widget] });
function Host() {
  const w = useWorkspace((s) => s.widgets.find((x) => x.id === ID))!;
  return <BrowserWidget widget={w} />;
}

beforeEach(() => {
  calls.length = 0;
  box = { left: 100, top: 100, width: 400, height: 300 };
  HTMLElement.prototype.getBoundingClientRect = function () {
    const mine = (this as HTMLElement).dataset.testid === "browser-body";
    const b = mine ? box : { left: 0, top: 0, width: 0, height: 0 };
    return { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => ({}) } as DOMRect;
  };
});
afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = realRect;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  FakeWebview.byLabel = null;
});

const address = () => screen.getByLabelText("Web address") as HTMLInputElement;
const go = (text: string) => {
  fireEvent.change(address(), { target: { value: text } });
  fireEvent.submit(address().closest("form")!);
};

test("in a plain tab an address opens in a framed page, a bad one is refused, and there is a link to a new tab", () => {
  put();
  render(<Host />);
  expect(screen.getByTestId("browser-body").textContent).toContain("many sites refuse");
  go("javascript:alert(1)");
  expect(screen.getByRole("alert").textContent).toContain("only http and https");
  expect(document.querySelector("iframe")).toBeNull();
  go("eia.gov");
  expect(document.querySelector("iframe")!.getAttribute("src")).toBe("https://eia.gov/");
  expect(document.querySelector("iframe")!.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  expect(screen.getByLabelText("Open in a new tab").getAttribute("href")).toBe("https://eia.gov/");
  fireEvent.click(screen.getByText("EIA"));
  expect(useWorkspace.getState().widgets[0].url).toContain("eia.gov/petroleum");
  expect(screen.queryByLabelText("Back")).toBeNull(); // no native view, no navigation buttons
});

test("in the desktop app the page is a native view over the panel body, not an iframe", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  put("https://www.eia.gov/");
  render(<Host />);
  await waitFor(() => expect(calls.find((c) => c.op === "invoke:browser_open")).toBeTruthy());
  expect(calls.find((c) => c.op === "invoke:browser_open")!.args).toEqual([{ label: "browser-bw", url: "https://www.eia.gov/", x: 100, y: 100, width: 400, height: 300 }]);
  expect(document.querySelector("iframe")).toBeNull();
  await waitFor(() => expect(screen.getByText(/2 extensions loaded/)).toBeTruthy()); // what the Rust side found in the extensions folder is shown
});

test("the native view follows the panel when it moves or resizes, and hides when it has no room or a dialog is open", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  put("https://www.eia.gov/");
  render(<Host />);
  await waitFor(() => expect(calls.some((c) => c.op === "invoke:browser_open")).toBe(true));
  await act(async () => await new Promise((r) => setTimeout(r, 40)));
  expect(calls.some((c) => c.op === "position")).toBe(false); // nothing moved yet
  box = { left: 220, top: 130, width: 500, height: 260 };
  await waitFor(() => expect(calls.filter((c) => c.op === "position").at(-1)?.args).toEqual([220, 130]));
  expect(calls.filter((c) => c.op === "size").at(-1)?.args).toEqual([500, 260]);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.appendChild(dialog);
  await waitFor(() => expect(calls.some((c) => c.op === "hide")).toBe(true));
  dialog.remove();
  await waitFor(() => expect(calls.some((c) => c.op === "show")).toBe(true));
  // a dialog that is in the page but hidden (the chart library keeps one for good) must not hide the view
  const before = calls.filter((c) => c.op === "hide").length;
  const hiddenDialog = document.createElement("div");
  hiddenDialog.setAttribute("role", "dialog");
  hiddenDialog.hidden = true;
  document.body.appendChild(hiddenDialog);
  await act(async () => await new Promise((r) => setTimeout(r, 60)));
  expect(calls.filter((c) => c.op === "hide").length).toBe(before);
  hiddenDialog.remove();
});

test("a new address goes to the same view through the one fixed command, the buttons use it, and closing the panel closes the view", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  put("https://www.eia.gov/");
  const { unmount } = render(<Host />);
  await waitFor(() => expect(screen.getByLabelText("Back").hasAttribute("disabled")).toBe(false));
  go("cmegroup.com");
  await waitFor(() => expect(calls.find((c) => c.op === "invoke:browser_action" && (c.args![0] as { action: string }).action === "go")).toBeTruthy());
  expect(calls.find((c) => c.op === "invoke:browser_action")!.args).toEqual([{ label: "browser-bw", action: "go", url: "https://cmegroup.com/" }]);
  fireEvent.click(screen.getByLabelText("Back"));
  fireEvent.click(screen.getByLabelText("Forward"));
  fireEvent.click(screen.getByLabelText("Reload"));
  await waitFor(() => expect(calls.filter((c) => c.op === "invoke:browser_action").map((c) => (c.args![0] as { action: string }).action)).toEqual(["go", "back", "forward", "reload"]));
  expect(calls.filter((c) => c.op === "invoke:browser_open")).toHaveLength(1); // a new address did not make a second view
  unmount();
  await waitFor(() => expect(calls.some((c) => c.op === "close")).toBe(true));
});

test("a view that cannot open says so in the panel instead of failing quietly", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const orig = FakeWebview.getByLabel;
  FakeWebview.getByLabel = async () => {
    throw new Error("no window");
  };
  put("https://www.eia.gov/");
  render(<Host />);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("The browser view could not open: no window"));
  FakeWebview.getByLabel = orig;
});
