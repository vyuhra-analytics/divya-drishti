import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// hls.js needs MediaSource: a fake that records what the widget asks of it
const hlsLog: { loaded: string[]; destroyed: number; handlers: Record<string, (...a: unknown[]) => void>; supported: boolean } = {
  loaded: [],
  destroyed: 0,
  handlers: {},
  supported: true,
};
class FakeHls {
  static Events = { MANIFEST_PARSED: "parsed", ERROR: "error" };
  static isSupported = () => hlsLog.supported;
  latency = 12;
  targetLatency = 3;
  liveSyncPosition = 100;
  on(ev: string, fn: (...a: unknown[]) => void) {
    hlsLog.handlers[ev] = fn;
  }
  loadSource(url: string) {
    hlsLog.loaded.push(url);
  }
  attachMedia() {}
  destroy() {
    hlsLog.destroyed++;
  }
}
mock.module("hls.js/light", () => ({ default: FakeHls }));

const { TvWidget, BUILTIN_CHANNELS } = await import("./TvWidget");
const { useWorkspace } = await import("./workspace");

const widget = { id: "tv1", type: "tv", symbol: "CRUDEOIL", group: null } as never;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  cleanup();
  hlsLog.loaded.length = 0;
  hlsLog.destroyed = 0;
  hlsLog.supported = true;
});

test("opens the default channel through hls.js and shows connecting", async () => {
  render(<TvWidget widget={widget} />);
  await flush();
  expect(hlsLog.loaded).toEqual([BUILTIN_CHANNELS[0].url]);
  expect(screen.getByText(/Connecting to/)).toBeTruthy();
});

test("a fatal stream error is shown with a hint to switch channel", async () => {
  render(<TvWidget widget={widget} />);
  await flush();
  act(() => hlsLog.handlers.error({}, { fatal: true, details: "manifestLoadError" }));
  expect(screen.getByText(/Stream unavailable \(manifestLoadError\)/)).toBeTruthy();
});

test("a browser with neither hls.js support nor native HLS says so", async () => {
  hlsLog.supported = false;
  render(<TvWidget widget={widget} />);
  await flush();
  expect(screen.getByText(/can't play HLS/)).toBeTruthy();
});

test("choosing another channel is saved on the widget", async () => {
  useWorkspace.setState({ widgets: [{ ...(widget as object) } as never] });
  render(<TvWidget widget={widget} />);
  await flush();
  const other = BUILTIN_CHANNELS[1];
  fireEvent.change(screen.getByLabelText("Channel"), { target: { value: other.url } });
  expect(useWorkspace.getState().widgets.find((w) => w.id === "tv1")?.channel).toBe(other.url);
});

test("unmounting tears the player down", async () => {
  const { unmount } = render(<TvWidget widget={widget} />);
  await flush();
  unmount();
  expect(hlsLog.destroyed).toBe(1);
});
