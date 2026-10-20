import { useEffect, useRef, useState } from "react";
import { useSettings } from "./settings";

/** Live HLS TV. hls.js is loaded on first use so it stays out of the main bundle. */
export function TvWidget() {
  const channels = useSettings((s) => s.tvChannels);
  const [url, setUrl] = useState(channels[0]?.url);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const current = channels.find((c) => c.url === url) ?? channels[0];

  useEffect(() => {
    const el = video.current;
    if (!el || !current) return;
    setError(null);
    let cancelled = false;
    let destroy = () => {};

    // hls.js first: recent Chrome answers canPlayType("…mpegurl") with "maybe" but fails to demux many streams.
    // Native playback is the fallback for browsers without MediaSource (iPhone Safari).
    import("hls.js/light").then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        if (!el.canPlayType("application/vnd.apple.mpegurl")) return setError("This browser can't play HLS streams.");
        el.src = current.url;
        el.play().catch(() => {});
        destroy = () => {
          el.removeAttribute("src");
          el.load();
        };
      } else {
        const hls = new Hls();
        hls.on(Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}));
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setError(`Stream unavailable (${data.details}). Try another channel.`);
        });
        hls.loadSource(current.url);
        hls.attachMedia(el);
        destroy = () => hls.destroy();
      }
    });
    return () => {
      cancelled = true;
      destroy();
    };
  }, [current]);

  if (!current) return <p className="empty muted">No TV channels. Add one in Settings → Live TV.</p>;

  return (
    <div className="tv">
      <div className="toolbar no-drag">
        {channels.map((c) => (
          <button key={c.url} className={c === current ? "tf active" : "tf"} onClick={() => setUrl(c.url)}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="tv-screen">
        <video ref={video} autoPlay muted controls playsInline />
        {error && <p className="tv-error">{error}</p>}
      </div>
    </div>
  );
}
