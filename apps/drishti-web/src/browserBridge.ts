// The pure parts of the in-app browser panel: which text becomes which web address, the label of a panel's native view, and where that view goes. In the
// desktop app the panel is a second native webview laid over its own rectangle (Tauri child webview); these helpers decide what it opens and where it sits.

/** Running inside the Tauri desktop shell (not in a plain browser tab). */
export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const SEARCH_URL = "https://duckduckgo.com/?q=";

/**
 * Turn what the trader typed into a web address. Only http and https are ever opened (no javascript:, file:, data:). A bare name with a dot is a site
 * (`eia.gov`), `localhost:3000` is a local page, anything else is a search.
 */
export function normalizeAddress(input: string): { url: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "type a web address or something to search for" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  const hostPort = /^[^\s/:]+:\d+(?:[/?#]|$)/.test(text); // localhost:3000 looks like a scheme but is not one
  if (scheme && !hostPort) {
    if (!/^https?$/i.test(scheme[1])) return { error: `only http and https addresses can be opened (not ${scheme[1].toLowerCase()}:)` };
    return validUrl(text);
  }
  if (/\s/.test(text) || (!/[.]/.test(text) && !/^localhost\b/i.test(text))) return { url: SEARCH_URL + encodeURIComponent(text) };
  return validUrl(`${/^(localhost|127\.|\[::1\])/i.test(text) ? "http" : "https"}://${text}`);
}

function validUrl(text: string): { url: string } | { error: string } {
  try {
    const u = new URL(text);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "only http and https addresses can be opened" };
    if (!u.hostname) return { error: "that is not a web address" };
    return { url: u.toString() };
  } catch {
    return { error: "that is not a web address" };
  }
}

/** The label of a panel's native view. The desktop command only drives labels that start with `browser-`. */
export const labelFor = (widgetId: string) => `browser-${widgetId.replace(/[^A-Za-z0-9_-]/g, "-")}`;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
};

export const sameRect = (a: Rect | undefined, b: Rect | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** The part of `a` that lies inside `b`, or undefined when they do not overlap. */
export function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

/** A native view smaller than this is not worth showing (a panel squeezed to nothing, or scrolled almost out of the grid). */
export const MIN_SIDE = 24;

/** Where the native view should sit: the panel's body clipped to the area it may use (the grid). Undefined means hide it. */
export function placement(body: Rect, area: Rect): Rect | undefined {
  const r = intersect(body, area);
  return r && r.width >= MIN_SIDE && r.height >= MIN_SIDE ? r : undefined;
}

/** Things drawn by the web page that a native view would cover, so the view steps aside while one is open. */
export const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

/** Is one of those drawn right now? A hidden one does not count (the chart library keeps a hidden colour-picker dialog in the page for good). */
export function overlayOpen(root: ParentNode = document): boolean {
  return [...root.querySelectorAll(OVERLAY_SELECTOR)].some((el) => {
    const e = el as HTMLElement;
    const style = getComputedStyle(e);
    return !e.closest("[hidden]") && style.display !== "none" && style.visibility !== "hidden";
  });
}
