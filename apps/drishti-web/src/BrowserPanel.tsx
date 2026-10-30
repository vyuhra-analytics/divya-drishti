import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";
import { intersect, isDesktop, labelFor, normalizeAddress, overlayOpen, placement, rectOf, sameRect, type Rect } from "./browserBridge";
import { Button, Input } from "./ui";
import { useWorkspace, type Widget } from "./workspace";

// A live browser inside a panel. In the desktop app the page is a SECOND NATIVE WEBVIEW (Tauri child webview) laid over this panel's body: a real browser
// engine, so any site opens, logins stay, and nothing is framed. It follows the panel when the grid moves or resizes it and steps aside while a dialog or menu
// of this app is open (a native view would sit on top of them). Websites get no access to the app's commands (the capability lists no remote URLs). In a plain
// browser tab there is no native view: the page is shown in an iframe, which many sites refuse (their choice, not ours), with a link to open it in a tab.

const BOOKMARKS: [string, string][] = [
  ["TradingView", "https://www.tradingview.com/chart/"],
  ["Upstox", "https://pro.upstox.com/"],
  ["MCX", "https://www.mcxindia.com/"],
  ["EIA", "https://www.eia.gov/petroleum/supply/weekly/"],
  ["CME", "https://www.cmegroup.com/markets/energy.html"],
];

type Tauri = {
  Webview: typeof import("@tauri-apps/api/webview").Webview;
  getCurrentWindow: typeof import("@tauri-apps/api/window").getCurrentWindow;
  invoke: typeof import("@tauri-apps/api/core").invoke;
  LogicalPosition: typeof import("@tauri-apps/api/dpi").LogicalPosition;
  LogicalSize: typeof import("@tauri-apps/api/dpi").LogicalSize;
};
/**
 * WebView2 installs unpacked extensions AFTER it has created the view, so the first page can finish loading before they are ready and runs without them.
 * When extensions are present the page is therefore opened a second time once they have had this long to install (measured: a navigation 2.5 s after the
 * view was created ran the test extension, the first load never did).
 */
export const EXTENSION_SETTLE_MS = 1500;

let tauriLoad: Promise<Tauri> | undefined;
const loadTauri = () =>
  (tauriLoad ??= Promise.all([import("@tauri-apps/api/webview"), import("@tauri-apps/api/window"), import("@tauri-apps/api/core"), import("@tauri-apps/api/dpi")]).then(([w, win, core, dpi]) => ({
    Webview: w.Webview,
    getCurrentWindow: win.getCurrentWindow,
    invoke: core.invoke,
    LogicalPosition: dpi.LogicalPosition,
    LogicalSize: dpi.LogicalSize,
  })));

/** The area a native view may cover: the panel grid (the page's <main>), else the whole window. */
const gridArea = (): Rect => {
  const main = document.querySelector("main");
  const win: Rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  return main ? (intersect(rectOf(main), win) ?? win) : win;
};

export function BrowserWidget({ widget }: { widget: Widget }) {
  const setUrl = useWorkspace((s) => s.setUrl);
  const url = widget.url;
  const desktop = isDesktop();
  const label = labelFor(widget.id);
  const body = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState(url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [extensions, setExtensions] = useState<{ dir: string; count: number } | null>(null);
  const opened = useRef<string | undefined>(undefined); // the address the native view was last sent to

  useEffect(() => setTyped(url ?? ""), [url]);

  // the native view: created once for this panel, kept over the panel's rectangle, closed with the panel
  useEffect(() => {
    if (!desktop || !url || !body.current) return;
    let alive = true;
    let view: InstanceType<Tauri["Webview"]> | undefined;
    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const t = await loadTauri();
        const stale = await t.Webview.getByLabel(label); // a leftover from a reload of the page
        await stale?.close().catch(() => {});
        if (!alive || !body.current) return;
        const first = placement(rectOf(body.current), gridArea()) ?? { x: 0, y: 0, width: 400, height: 300 };
        // created by the app's Rust side (own profile folder, and on Windows the unpacked extensions in the app's extensions folder)
        const made = await t.invoke<{ extensions_dir: string; extensions: number }>("browser_open", { label, url, ...first });
        const created = await t.Webview.getByLabel(label);
        if (!created) throw new Error("the view was created but cannot be found");
        view = created;
        opened.current = url;
        setExtensions({ dir: made.extensions_dir, count: made.extensions });
        if (made.extensions > 0)
          settle = setTimeout(() => {
            if (opened.current) void t.invoke("browser_action", { label, action: "go", url: opened.current }).catch(() => {});
          }, EXTENSION_SETTLE_MS);
        if (!alive) return void created.close().catch(() => {});
        setReady(true);
        let last: Rect | undefined = first;
        let hidden = false;
        const follow = () => {
          frame = requestAnimationFrame(follow);
          if (!body.current || !view) return;
          const overlay = overlayOpen();
          const spot = overlay ? undefined : placement(rectOf(body.current), gridArea());
          if (!spot) {
            if (!hidden) void view.hide().catch(() => {});
            hidden = true;
            return;
          }
          if (hidden) void view.show().catch(() => {});
          hidden = false;
          if (sameRect(spot, last)) return;
          last = spot;
          void view.setPosition(new t.LogicalPosition(spot.x, spot.y)).catch(() => {});
          void view.setSize(new t.LogicalSize(spot.width, spot.height)).catch(() => {});
        };
        follow();
      } catch (e) {
        if (alive) setError(`The browser view could not open: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      setReady(false);
      opened.current = undefined;
      void view?.close().catch(() => {});
    };
  }, [desktop, !!url, widget.id]);

  // a new address while the view is open: send the same view there
  useEffect(() => {
    if (!desktop || !url || !ready || opened.current === url) return;
    opened.current = url;
    void loadTauri().then((t) => t.invoke("browser_action", { label, action: "go", url })).catch((e) => setError(String(e)));
  }, [desktop, url, ready]);

  const act = (action: "back" | "forward" | "reload") => void loadTauri().then((t) => t.invoke("browser_action", { label, action })).catch((e) => setError(String(e)));

  const open = (text: string) => {
    const r = normalizeAddress(text);
    if ("error" in r) return setError(r.error);
    setError(null);
    setUrl(widget.id, r.url);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    open(typed);
  };

  return (
    <div className="browser" data-testid="browser-panel">
      <form className="browser-bar" onSubmit={submit}>
        {desktop && (
          <>
            <Button type="button" size="icon" variant="ghost" aria-label="Back" disabled={!ready} onClick={() => act("back")}>
              <ArrowLeft size={14} />
            </Button>
            <Button type="button" size="icon" variant="ghost" aria-label="Forward" disabled={!ready} onClick={() => act("forward")}>
              <ArrowRight size={14} />
            </Button>
            <Button type="button" size="icon" variant="ghost" aria-label="Reload" disabled={!ready} onClick={() => act("reload")}>
              <RotateCw size={14} />
            </Button>
          </>
        )}
        <Input aria-label="Web address" value={typed} placeholder="Web address, or words to search for" onChange={(e) => setTyped(e.target.value)} />
        <Button type="submit" size="sm">
          Go
        </Button>
        {url && !desktop && (
          <Button asChild size="icon" variant="ghost" aria-label="Open in a new tab">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} />
            </a>
          </Button>
        )}
      </form>
      <div className="browser-marks">
        {BOOKMARKS.map(([name, address]) => (
          <Button key={name} type="button" size="sm" variant="ghost" onClick={() => open(address)}>
            {name}
          </Button>
        ))}
      </div>
      {desktop && extensions && (
        <p className="muted browser-ext" title={extensions.dir}>
          {extensions.count} extension{extensions.count === 1 ? "" : "s"} loaded (Windows, unpacked, from {extensions.dir})
        </p>
      )}
      {error && (
        <p className="down browser-error" role="alert">
          {error}
        </p>
      )}
      <div ref={body} className="browser-body" data-testid="browser-body">
        {!url && <p className="muted">Type an address above, or pick a site. {desktop ? "It opens in a real browser view inside this panel." : "In the desktop app any site opens here; in a browser tab many sites refuse to be shown in a frame."}</p>}
        {url && !desktop && <iframe title="Web page" src={url} className="browser-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerPolicy="no-referrer" />}
      </div>
    </div>
  );
}
