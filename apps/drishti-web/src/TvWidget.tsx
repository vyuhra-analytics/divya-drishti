import { useEffect, useRef, useState } from "react";
import { useSettings, type TvChannel } from "./settings";
import { useWorkspace, type Widget } from "./workspace";

/** Official broadcaster streams only (served from the broadcaster's own domain/CDN). */
/** First entry is the default channel for new TV panels. */
export const BUILTIN_CHANNELS: (TvChannel & { group: string })[] = [
  { group: "Bloomberg", name: "Bloomberg TV+", url: "https://www.bloomberg.com/media-manifest/streams/phoenix-us.m3u8" },
  { group: "Bloomberg", name: "Bloomberg TV US", url: "https://www.bloomberg.com/media-manifest/streams/us.m3u8" },
  { group: "Bloomberg", name: "Bloomberg TV Europe", url: "https://www.bloomberg.com/media-manifest/streams/eu.m3u8" },
  { group: "Bloomberg", name: "Bloomberg TV Asia", url: "https://www.bloomberg.com/media-manifest/streams/asia.m3u8" },
  { group: "Bloomberg", name: "Bloomberg Originals", url: "https://www.bloomberg.com/media-manifest/streams/qt.m3u8" },
  { group: "India", name: "NDTV Profit", url: "https://ndtvprofit.akamaized.net/hls/live/2107404/ndtvprofit/master_1.m3u8" },
];

type Status = "loading" | "playing" | "error";

/** Seconds behind the normal live point before we offer "Go live" (playback drifts a little around it). */
const BEHIND_THRESHOLD = 5;

interface Live {
  /** seconds behind the normal live playback point */
  lag: () => number;
  goLive: () => void;
}
const NOT_LIVE: Live = { lag: () => 0, goLive: () => {} };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function useChannels() {
  const custom = useSettings((s) => s.tvChannels);
  const builtin = new Set(BUILTIN_CHANNELS.map((c) => c.url));
  return [...BUILTIN_CHANNELS, ...custom.filter((c) => !builtin.has(c.url)).map((c) => ({ ...c, group: "My channels" }))];
}

/**
 * Attach an HLS stream to the video element; returns cleanup. hls.js first, native HLS only as fallback.
 * `live` is pointed at lag / go-live controls for whichever player ends up in use.
 */
function play(el: HTMLVideoElement, url: string, onStatus: (s: Status, msg?: string) => void, live: { current: Live }) {
  let cancelled = false;
  let destroy = () => {};
  live.current = NOT_LIVE;
  const onPlaying = () => onStatus("playing");
  el.addEventListener("playing", onPlaying);

  // Recent Chrome answers canPlayType("…mpegurl") with "maybe" but fails to demux many streams,
  // so native playback is only for browsers without MediaSource (iPhone Safari).
  import("hls.js/light").then(({ default: Hls }) => {
    if (cancelled) return;
    if (!Hls.isSupported()) {
      if (!el.canPlayType("application/vnd.apple.mpegurl")) return onStatus("error", "This browser can't play HLS streams.");
      el.src = url;
      el.play().catch(() => {});
      // native player: measure lag against the latency it settled at when playback first started
      const end = () => (el.seekable.length ? el.seekable.end(el.seekable.length - 1) : el.currentTime);
      let baseline: number | undefined;
      el.addEventListener("playing", () => (baseline ??= end() - el.currentTime), { once: true });
      live.current = {
        lag: () => (baseline === undefined ? 0 : Math.max(0, end() - el.currentTime - baseline)),
        goLive: () => {
          if (baseline !== undefined) el.currentTime = end() - baseline;
        },
      };
      destroy = () => {
        el.removeAttribute("src");
        el.load();
      };
      return;
    }
    // start from a broadband estimate (default 500 kbps opens at 144p) and don't fetch more pixels than the panel shows
    const hls = new Hls({ lowLatencyMode: true, abrEwmaDefaultEstimate: 5_000_000, capLevelToPlayerSize: true });
    hls.on(Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) onStatus("error", `Stream unavailable (${data.details}). Try another channel.`);
    });
    hls.loadSource(url);
    hls.attachMedia(el);
    // hls.latency is extrapolated between playlist reloads, so it moves smoothly (playlist edge jumps a segment at a time)
    live.current = {
      lag: () => (Number.isFinite(hls.latency) ? Math.max(0, hls.latency - hls.targetLatency!) : 0),
      goLive: () => {
        if (hls.liveSyncPosition !== null) el.currentTime = hls.liveSyncPosition;
      },
    };
    destroy = () => hls.destroy();
  });

  return () => {
    cancelled = true;
    el.removeEventListener("playing", onPlaying);
    destroy();
  };
}

export function TvWidget({ widget }: { widget: Widget }) {
  const channels = useChannels();
  const setChannel = useWorkspace((s) => s.setChannel);
  const current = channels.find((c) => c.url === widget.channel) ?? channels[0];
  const video = useRef<HTMLVideoElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [res, setRes] = useState("");
  const [paused, setPaused] = useState(false);
  const [behind, setBehind] = useState(0);
  const live = useRef<Live>(NOT_LIVE);
  const pause = useRef<{ at: number; lag: number } | null>(null);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    setStatus("loading");
    setRes("");
    setBehind(0);
    return play(
      el,
      current.url,
      (s, msg = "") => {
        setStatus(s);
        setError(msg);
      },
      live,
    );
  }, [current.url]);

  // the live edge keeps moving while paused (no timeupdate then), so poll
  useEffect(() => {
    const id = setInterval(() => {
      const p = pause.current;
      // while paused, latency only refreshes per playlist reload, so count the pause on the wall clock
      setBehind(p ? p.lag + (Date.now() - p.at) / 1000 : live.current.lag());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const togglePause = () => {
    const el = video.current!;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };
  const goLive = () => {
    live.current.goLive();
    video.current!.play().catch(() => {});
    setBehind(0);
  };
  const isBehind = paused || behind > BEHIND_THRESHOLD;

  useEffect(() => {
    const el = video.current!;
    el.muted = muted;
    el.volume = volume;
  }, [muted, volume]);

  const groups = [...new Set(channels.map((c) => c.group))];

  return (
    <div className="tv">
      <div className="toolbar no-drag">
        <select
          className="tv-select"
          aria-label="Channel"
          value={current.url}
          onChange={(e) => setChannel(widget.id, e.target.value)}
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {channels
                .filter((c) => c.group === g)
                .map((c) => (
                  <option key={c.url} value={c.url}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div
        ref={screen}
        className="tv-screen"
        tabIndex={0}
        aria-label={`${current.name} player`}
        onKeyDown={(e) => {
          if (e.key === " " || e.key.toLowerCase() === "k") {
            e.preventDefault();
            togglePause();
          }
        }}
      >
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          onResize={(e) => setRes(e.currentTarget.videoHeight ? `${e.currentTarget.videoHeight}p` : "")}
          onPause={() => {
            pause.current = { at: Date.now(), lag: live.current.lag() };
            setPaused(true);
          }}
          onPlay={() => {
            pause.current = null;
            setPaused(false);
          }}
          onClick={togglePause}
          onDoubleClick={() => (document.fullscreenElement ? document.exitFullscreen() : screen.current?.requestFullscreen())}
        />

        {status === "loading" && <div className="tv-state">Connecting to {current.name}…</div>}
        {status === "error" && <div className="tv-state">{error}</div>}
        {status === "playing" && paused && (
          <button className="tv-big-play" aria-label="Resume" onClick={togglePause}>
            ▶
          </button>
        )}

        <div className="tv-top">
          {status === "playing" && isBehind ? (
            <button className="tv-live behind" title="Jump to live" onClick={goLive}>
              ● GO LIVE <span>−{clock(behind)}</span>
            </button>
          ) : (
            <span className={`tv-live ${status === "playing" ? "on" : ""}`}>● LIVE</span>
          )}
          <span className="tv-name">{current.name}</span>
          {res && <span className="tv-res">{res}</span>}
        </div>

        <div className="tv-controls no-drag">
          <button aria-label={paused ? "Play" : "Pause"} title={paused ? "Play (Space)" : "Pause (Space)"} onClick={togglePause}>
            {paused ? "▶" : "❚❚"}
          </button>
          <button aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)}>
            {muted ? "🔇" : "🔊"}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(e) => {
              setVolume(+e.target.value);
              setMuted(+e.target.value === 0);
            }}
          />
          <span className="spacer" />
          {document.pictureInPictureEnabled && (
            <button
              aria-label="Picture in picture"
              title="Picture in picture"
              onClick={() =>
                document.pictureInPictureElement ? document.exitPictureInPicture() : video.current?.requestPictureInPicture()
              }
            >
              ⧉
            </button>
          )}
          <button
            aria-label="Fullscreen"
            title="Fullscreen (double-click video)"
            onClick={() => (document.fullscreenElement ? document.exitFullscreen() : screen.current?.requestFullscreen())}
          >
            ⛶
          </button>
        </div>
      </div>
    </div>
  );
}
