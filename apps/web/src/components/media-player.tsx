"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { formatTime, type RoomState, type Source } from "@/lib/protocol";

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApi: Promise<typeof YT> | undefined;
function loadYouTube(): Promise<typeof YT> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApi) return youtubeApi;
  youtubeApi = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      youtubeApi = undefined;
      reject(
        new Error(
          "YouTube took too long to load. Try a different source or reload.",
        ),
      );
    }, 15_000);
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      resolve(window.YT);
    };
    script.src = "https://www.youtube.com/iframe_api";
    script.nonce =
      document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";
    script.onerror = () => {
      window.clearTimeout(timeout);
      youtubeApi = undefined;
      reject(
        new Error(
          "YouTube could not load. Check your connection or browser extensions.",
        ),
      );
    };
    document.head.append(script);
  });
  return youtubeApi;
}

interface PlayerAdapter {
  play(): void | Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  time(): number;
  duration(): number;
  mute(value: boolean): void;
}

export function MediaPlayer({
  source,
  state,
  connected,
  onPlayback,
  onFullscreen,
}: {
  source: Exclude<Source, { kind: "screen" }>;
  state: RoomState;
  connected: boolean;
  onPlayback: (playing: boolean, position: number) => void;
  onFullscreen: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const native = useRef<HTMLVideoElement>(null);
  const youtube = useRef<HTMLDivElement>(null);
  const adapter = useRef<PlayerAdapter | null>(null);
  const latest = useRef({ state, connected, received: performance.now() });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState({ time: 0, duration: 0 });

  function apply() {
    const player = adapter.current;
    if (!player) return;
    const { state, connected, received } = latest.current;
    const target =
      state.position +
      (state.playing && connected ? (performance.now() - received) / 1000 : 0);
    if (Math.abs(player.time() - target) > 1.25) player.seek(target);
    if (state.playing && connected) {
      const promise = player.play();
      if (promise) promise.catch(() => setNeedsGesture(true));
    } else player.pause();
  }

  useEffect(() => {
    latest.current = { state, connected, received: performance.now() };
    if (ready) apply();
  }, [state, connected, ready]);

  useEffect(() => {
    let disposed = false;
    let yt: YT.Player | undefined;
    setReady(false);
    setError("");
    setNeedsGesture(false);
    setMuted(false);
    if (source.kind === "video" && native.current) {
      const video = native.current;
      adapter.current = {
        play: () => (video.paused ? video.play() : undefined),
        pause: () => video.pause(),
        seek: (time) => {
          video.currentTime = time;
        },
        time: () => video.currentTime,
        duration: () => video.duration,
        mute: (value) => {
          video.muted = value;
        },
      };
    } else if (source.kind === "youtube") {
      loadYouTube()
        .then((YT) => {
          if (disposed || !youtube.current) return;
          const element = document.createElement("div");
          youtube.current.replaceChildren(element);
          yt = new YT.Player(element, {
            host: "https://www.youtube-nocookie.com",
            videoId: source.url,
            width: "100%",
            height: "100%",
            playerVars: {
              playsinline: 1,
              controls: 0,
              rel: 0,
              origin: window.location.origin,
            },
            events: {
              onReady: ({ target }) => {
                if (disposed) return;
                target.getIframe().title = "Shared YouTube video";
                adapter.current = {
                  play: () => {
                    if (target.getPlayerState() !== 1) target.playVideo();
                  },
                  pause: () => target.pauseVideo(),
                  seek: (time) => target.seekTo(time, true),
                  time: () => target.getCurrentTime(),
                  duration: () => target.getDuration(),
                  mute: (value) => (value ? target.mute() : target.unMute()),
                };
                setReady(true);
              },
              onAutoplayBlocked: () => {
                if (!disposed) setNeedsGesture(true);
              },
              onError: () => {
                if (!disposed)
                  setError(
                    "This video cannot play here. It may be private, restricted, or unavailable for embedding. Choose another video or share a tab.",
                  );
              },
              onStateChange: ({ data }) => {
                if (!disposed && data === 0) onPlayback(false, 0);
                if (
                  !disposed &&
                  (data === 1 || data === 2) &&
                  latest.current.connected &&
                  (data === 1) !== latest.current.state.playing
                ) {
                  onPlayback(data === 1, adapter.current?.time() ?? 0);
                }
              },
            },
          });
        })
        .catch((error: Error) => {
          if (!disposed) setError(error.message);
        });
    }
    const timer = window.setInterval(() => {
      if (adapter.current)
        setProgress({
          time: adapter.current.time(),
          duration: adapter.current.duration() || 0,
        });
    }, 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      yt?.destroy();
      adapter.current = null;
    };
    // A source change remounts this component; callbacks use the stable room connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, source.url]);

  function playPause() {
    if (!adapter.current || !connected) return;
    setNeedsGesture(false);
    const playing = needsGesture || !state.playing;
    if (playing) {
      const play = adapter.current.play();
      if (play) play.catch(() => setNeedsGesture(true));
    } else adapter.current.pause();
    onPlayback(playing, adapter.current.time());
  }

  return (
    <div ref={container} className="media-player">
      <div className={`media-viewport ${source.kind}`}>
        {source.kind === "video" ? (
          <video
            ref={native}
            src={source.url}
            playsInline
            preload="metadata"
            onLoadedMetadata={() => setReady(true)}
            onError={() =>
              setError(
                "This video could not load. Check that the link is a playable public MP4/WebM file.",
              )
            }
            onEnded={() => onPlayback(false, 0)}
            aria-label="Shared video"
          />
        ) : (
          <div className="youtube-player" ref={youtube} />
        )}
        {!ready && !error && (
          <div className="player-loading">
            <span className="loading-ring" />
            Getting the picture…
          </div>
        )}
        {error && (
          <div className="player-message" role="alert">
            <p>{error}</p>
          </div>
        )}
        {needsGesture && !error && (
          <button
            className="button button-primary enable-playback"
            onClick={playPause}
          >
            <Play size={17} aria-hidden /> Enable playback & sound
          </button>
        )}
      </div>
      <div className="player-controls">
        <button
          className="icon-button"
          aria-label={
            state.playing && !needsGesture ? "Pause for both" : "Play for both"
          }
          onClick={playPause}
          disabled={!ready || !connected}
        >
          {state.playing && !needsGesture ? (
            <Pause size={19} aria-hidden />
          ) : (
            <Play size={19} aria-hidden />
          )}
        </button>
        <span className="player-time">{formatTime(progress.time)}</span>
        <input
          aria-label="Seek for both viewers"
          type="range"
          min="0"
          max={Number.isFinite(progress.duration) ? progress.duration : 0}
          step="1"
          value={Math.min(progress.time, progress.duration)}
          disabled={!ready || !connected || !progress.duration}
          onChange={(event) => {
            const position = Number(event.target.value);
            adapter.current?.seek(position);
            onPlayback(state.playing, position);
          }}
        />
        <span className="player-time">{formatTime(progress.duration)}</span>
        <button
          className="icon-button"
          aria-label={muted ? "Unmute on your device" : "Mute on your device"}
          aria-pressed={muted}
          onClick={() => {
            adapter.current?.mute(!muted);
            setMuted(!muted);
          }}
          disabled={!ready}
        >
          {muted ? (
            <VolumeX size={19} aria-hidden />
          ) : (
            <Volume2 size={19} aria-hidden />
          )}
        </button>
        <button
          className="icon-button fullscreen-button"
          aria-label="Enter fullscreen"
          onClick={onFullscreen}
        >
          <Maximize size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function ScreenPlayer({
  stream,
  local,
  controls = true,
}: {
  stream: MediaStream | null;
  local: boolean;
  controls?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) element.play().catch(() => setNeedsGesture(true));
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  return (
    <div className="screen-player">
      <video
        ref={video}
        playsInline
        autoPlay
        muted={local}
        controls={controls}
        aria-label={
          local ? "Your shared screen preview" : "Your partner’s shared screen"
        }
      />
      {!stream && (
        <div className="player-loading">
          <span className="loading-ring" />
          Connecting to their screen…
        </div>
      )}
      {needsGesture && stream && (
        <button
          className="button button-primary enable-playback"
          onClick={() => {
            video.current
              ?.play()
              .then(() => setNeedsGesture(false))
              .catch(() => setNeedsGesture(true));
          }}
        >
          Enable screen audio & video
        </button>
      )}
    </div>
  );
}
