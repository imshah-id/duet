"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useReducer,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Link2,
  LockKeyhole,
  MonitorUp,
  Maximize,
  Minimize,
  PanelRightClose,
  PanelRightOpen,
  Eye,
  EyeOff,
  Play,
  Plus,
  Radio,
  Send,
  Square,
  Volume2,
  X,
} from "lucide-react";
import { Brand } from "./brand";
import { LilyScene } from "./lily-scene";
import { MediaPlayer, ScreenPlayer } from "./media-player";
import { RoomClient, type ConnectionStatus } from "@/lib/room-client";
import {
  parseInvite,
  parseSource,
  type ChatMessage,
  type Command,
  type Role,
  type RoomState,
} from "@/lib/protocol";
import { readSession, saveSession, type RoomSession } from "@/lib/session";
import { ScreenSession } from "@/lib/screen-session";
import { changeView, initialView } from "@/lib/view-mode";

export function WatchRoom({ id }: { id: string }) {
  const [session, setSession] = useState<RoomSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [role, setRole] = useState<Role>("guest");
  const [state, setState] = useState<RoomState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [error, setError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourcePending, setSourcePending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenStatus, setScreenStatus] = useState("");
  const [screenAudio, setScreenAudio] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useReducer(changeView, initialView);
  const watchStage = useRef<HTMLDivElement>(null);
  const focusTrigger = useRef<HTMLButtonElement>(null);
  const focusControls = useRef<HTMLButtonElement>(null);
  const client = useRef<RoomClient | null>(null);
  const screen = useRef<ScreenSession | null>(null);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const chatLog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!view.focus) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    focusControls.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setView("exit-focus");
    };
    window.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", escape);
      focusTrigger.current?.focus();
    };
  }, [view.focus]);

  function fullscreen() {
    const stage = watchStage.current;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (stage?.requestFullscreen)
      void stage.requestFullscreen().catch(() => setView("enter-focus"));
    else setView("enter-focus");
  }

  useEffect(() => {
    try {
      let saved = readSession(id);
      if (window.location.hash) {
        const invite = parseInvite(
          window.location.href,
          window.location.origin,
        );
        saved = {
          token: invite.token,
          expires: Date.now() + 6 * 60 * 60 * 1000,
        };
        saveSession(id, saved);
        window.history.replaceState(null, "", `/room/${id}`);
      }
      setSession(saved);
      setName(saved?.name ?? "");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "This invite could not be opened.",
      );
    }
    setLoaded(true);
    return () => clearTimeout(copyTimer.current);
  }, [id]);

  const send = useCallback((command: Command) => {
    const sent = client.current?.send(command) ?? false;
    if (!sent)
      setError("You’re disconnected. Reconnect before changing the room.");
    return sent;
  }, []);

  useEffect(() => {
    if (!session?.name) return;
    const connection = new RoomClient(
      (event) => {
        if (event.type === "welcome") {
          setRole(event.role);
          setState(event.state);
          screen.current?.close();
          screen.current = new ScreenSession(
            event.ice_servers,
            (signal) => connection.send({ type: "signal", signal }),
            setScreenStream,
            setScreenStatus,
          );
          setError("");
        } else if (event.type === "state") {
          setState(event.state);
        } else if (event.type === "chat")
          setMessages((messages) => [...messages.slice(-79), event]);
        else if (event.type === "signal") screen.current?.receive(event.signal);
        else if (event.type === "error") setError(event.message);
        else if (event.type === "expired") {
          setError(
            "This room has expired. Create a new room from the home page.",
          );
          connection.disconnect();
          setStatus("disconnected");
          screen.current?.close();
        }
      },
      (nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === "disconnected") screen.current?.close();
      },
    );
    client.current = connection;
    connection.connect(id, session.token, session.name);
    return () => {
      connection.disconnect();
      screen.current?.close();
      screen.current = null;
      client.current = null;
    };
  }, [id, session, attempt]);

  const isScreen = state?.source?.kind === "screen";
  const memberCount = state?.members.length ?? 0;
  useEffect(() => {
    if (!isScreen) {
      screen.current?.close();
      setScreenStatus("");
      return;
    }
    if (memberCount === 2 && role === "host")
      screen.current
        ?.offer()
        .catch(() =>
          setScreenStatus(
            "Could not connect your screen. Stop sharing and try again.",
          ),
        );
    if (memberCount < 2) {
      screen.current?.resetPeer();
      if (role === "guest") setScreenStream(null);
    }
  }, [isScreen, memberCount, role]);

  useEffect(() => {
    const log = chatLog.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  function join(event: FormEvent) {
    event.preventDefault();
    if (!session || !name.trim()) return;
    try {
      const next = { ...session, name: name.trim() };
      saveSession(id, next);
      setSession(next);
    } catch {
      setError("Enable session storage in your browser to join this room.");
    }
  }

  async function copyInvite() {
    if (!session?.invite) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/room/${id}#invite=${session.invite}`,
      );
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setError(
        "Clipboard access is blocked. Your browser must allow copying on this site.",
      );
    }
  }

  function chooseSource(event: FormEvent) {
    event.preventDefault();
    setSourceError("");
    try {
      const source = parseSource(sourceUrl);
      if (send({ type: "source", source })) {
        screen.current?.close();
        sourceDialog.current?.close();
        setSourceUrl("");
      }
    } catch (error) {
      setSourceError(
        error instanceof Error ? error.message : "Check your video link.",
      );
    }
  }

  async function shareScreen() {
    setSourceError("");
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setSourceError(
        "Screen sharing isn’t available in this browser. Try desktop Chrome or Edge over HTTPS.",
      );
      return;
    }
    setSourcePending(true);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 1920, max: 1920 },
        },
        audio: true,
      });
      if (!screen.current || status !== "connected") {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Reconnect to the room before sharing.");
      }
      screen.current.close();
      screen.current.setStream(stream);
      setScreenAudio(stream.getAudioTracks().length > 0);
      stream.getVideoTracks()[0].onended = () => {
        screen.current?.close();
        send({ type: "source", source: null });
      };
      if (!send({ type: "source", source: { kind: "screen" } })) {
        screen.current.close();
        return;
      }
      setScreenStatus(
        stream.getAudioTracks().length > 0
          ? "Video and audio captured"
          : "Video only — no audio track shared",
      );
      sourceDialog.current?.close();
    } catch (error) {
      setSourceError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Sharing was cancelled or denied. Choose a tab and enable Share audio to try again."
          : error instanceof Error
            ? error.message
            : "Could not start screen sharing.",
      );
    } finally {
      setSourcePending(false);
    }
  }

  const playback = useCallback(
    (playing: boolean, position: number) => {
      send({ type: "playback", playing, position });
    },
    [send],
  );
  const connected = status === "connected";
  const partner = state?.members.find((member) => member.role !== role);
  const host = role === "host";
  const openSources = () => {
    setSourceError("");
    sourceDialog.current?.showModal();
  };

  if (!loaded)
    return (
      <main className="centered-page">
        <span className="loading-ring" />
        <p>Connecting to the room…</p>
      </main>
    );
  if (!session || !session.name)
    return (
      <main className="join-page">
        <Brand />
        <div className="join-card">
          <h1>{session ? "Join the room" : "Invite required"}</h1>
          <p>
            {session
              ? "Enter the name your partner will see."
              : "Open the full invite link from your host, or start a room of your own."}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {session ? (
            <form onSubmit={join}>
              <label htmlFor="guest-name">Your name</label>
              <input
                id="guest-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={32}
                required
                pattern=".*\S.*"
                autoFocus
                autoComplete="nickname"
              />
              <button className="button button-primary full">
                Join room <ArrowRight size={18} aria-hidden />
              </button>
            </form>
          ) : (
            <Link href="/" className="button button-primary">
              Back to Duet <ArrowRight size={18} aria-hidden />
            </Link>
          )}
        </div>
      </main>
    );

  return (
    <div
      className={`room-shell ${view.focus ? "is-focused" : ""} ${!view.controls ? "controls-hidden" : ""}`}
    >
      <a href="#watch-content" className="skip-link">
        Skip to video
      </a>
      {view.focus && (
        <div className="focus-toolbar" aria-label="Focus view controls">
          {view.controls && (
            <button
              className="button button-outline small"
              onClick={() => setView("exit-focus")}
            >
              <Minimize size={17} aria-hidden /> Exit focus
            </button>
          )}
          <button
            ref={focusControls}
            className="button button-outline small"
            onClick={() => setView("toggle-controls")}
            aria-pressed={!view.controls}
          >
            {view.controls ? (
              <EyeOff size={17} aria-hidden />
            ) : (
              <Eye size={17} aria-hidden />
            )}
            {view.controls ? "Hide controls" : "Show controls"}
          </button>
        </div>
      )}
      <header className="room-header">
        <Brand />
        <Link href="/" className="button button-outline small">
          <ArrowLeft size={15} aria-hidden /> Leave room
        </Link>
      </header>
      <main className="room-main" id="watch-content">
        <div className="room-title-row">
          <div>
            <h1>Watch room</h1>
          </div>
          <div
            className={`connection-pill ${connected ? "online" : ""}`}
            role="status"
          >
            <span className="live-dot" />
            {connected
              ? "Room connected"
              : status === "connecting"
                ? "Connecting…"
                : "Disconnected"}
            {status === "disconnected" && (
              <button
                onClick={() => {
                  setError("");
                  setAttempt((n) => n + 1);
                }}
              >
                Reconnect
              </button>
            )}
          </div>
        </div>
        <div className="view-toolbar" aria-label="Viewing options">
          <span className="room-seats">
            <LockKeyhole size={14} aria-hidden /> Private · {memberCount}/2
            seats
          </span>
          <div className="view-buttons">
            <button
              className="button button-outline small"
              onClick={() => setView("toggle-sidebar")}
              aria-expanded={view.sidebar}
              aria-controls="room-sidebar"
            >
              {view.sidebar ? (
                <PanelRightClose size={17} aria-hidden />
              ) : (
                <PanelRightOpen size={17} aria-hidden />
              )}
              {view.sidebar ? "Hide chat" : "Show chat"}
            </button>
            <button
              ref={focusTrigger}
              className="button button-outline small"
              onClick={() => setView("enter-focus")}
            >
              <Maximize size={17} aria-hidden /> Focus view
            </button>
          </div>
        </div>
        {error && (
          <div className="room-error" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        )}
        <div
          className={`room-grid ${!view.sidebar || view.focus ? "without-sidebar" : ""}`}
        >
          <section className="watch-column" aria-label="Watch together">
            <div className="watch-stage" ref={watchStage}>
              {state?.source && state.source.kind !== "screen" ? (
                <MediaPlayer
                  key={JSON.stringify(state.source)}
                  source={state.source}
                  state={state}
                  connected={connected}
                  onPlayback={playback}
                  onFullscreen={fullscreen}
                />
              ) : isScreen ? (
                <ScreenPlayer
                  stream={screenStream}
                  local={host}
                  controls={view.controls}
                />
              ) : (
                <div className="empty-stage">
                  <LilyScene className="empty-lilies" />
                  <div className="stage-scrim" />
                  <div className="empty-stage-copy">
                    <h2>
                      {host
                        ? "Choose something to watch"
                        : "Waiting for your host"}
                    </h2>
                    <p>
                      {host
                        ? "Paste a video link or share a browser tab."
                        : "They’ll pick a video or share their screen."}
                    </p>
                    {host && (
                      <button
                        className="button button-primary"
                        onClick={openSources}
                        disabled={!connected}
                      >
                        <Plus size={17} aria-hidden /> Add a video
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            {state?.source && (
              <div className="watch-meta">
                <div>
                  <span className="watch-meta-icon">
                    {isScreen ? (
                      <MonitorUp size={18} aria-hidden />
                    ) : (
                      <Radio size={18} aria-hidden />
                    )}
                  </span>
                  <div>
                    <strong>
                      {state?.source?.kind === "youtube"
                        ? "YouTube"
                        : state?.source?.kind === "video"
                          ? "Shared video"
                          : isScreen
                            ? "Shared screen"
                            : "Ready when you are"}
                    </strong>
                    <span>
                      {isScreen
                        ? screenStatus || "Screen sharing"
                        : state?.source
                          ? "Play, pause, and seek are shared. Volume is yours."
                          : "YouTube, direct video links, or screen sharing."}
                    </span>
                  </div>
                </div>
                {host && (
                  <button
                    className="button button-outline small"
                    disabled={!connected}
                    onClick={
                      isScreen
                        ? () => {
                            screen.current?.close();
                            send({ type: "source", source: null });
                          }
                        : openSources
                    }
                  >
                    {isScreen ? (
                      <>
                        <Square size={13} aria-hidden /> Stop sharing
                      </>
                    ) : (
                      <>
                        <Plus size={15} aria-hidden />{" "}
                        {state?.source ? "Change video" : "Add video"}
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
            {isScreen && (
              <p
                className={`audio-notice ${host && !screenAudio ? "audio-warning" : ""}`}
              >
                <Volume2 size={15} aria-hidden />
                {host
                  ? screenAudio
                    ? "Audio is included. Your preview is muted to prevent an echo."
                    : "No audio track was captured. Share a browser tab and turn on Share tab audio."
                  : screenStream
                    ? screenStream.getAudioTracks().length
                      ? "Audio track received. Use the player’s volume control to listen."
                      : "The host is sharing video without audio."
                    : "Waiting for video and audio tracks…"}
              </p>
            )}
          </section>
          <aside
            className="room-sidebar"
            id="room-sidebar"
            hidden={!view.sidebar || view.focus}
          >
            <section className="together-panel">
              <div className="panel-heading">
                <h2>People</h2>
                <span>{memberCount} / 2</span>
              </div>
              <div className="member-row">
                <span className="avatar you-avatar">
                  {session.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>
                    {session.name} <span>(you)</span>
                  </strong>
                  <span>{host ? "Host" : "Guest"}</span>
                </div>
                <span
                  className={`presence-dot ${connected ? "present" : ""}`}
                />
              </div>
              <div className="member-row">
                <span
                  className={`avatar ${partner ? "partner-avatar" : "empty-avatar"}`}
                >
                  {partner ? (
                    partner.name.slice(0, 1).toUpperCase()
                  ) : (
                    <Plus size={18} aria-hidden />
                  )}
                </span>
                <div>
                  <strong>{partner?.name ?? "Waiting for a guest"}</strong>
                  <span>
                    {partner ? "Connected" : "Share your private invite"}
                  </span>
                </div>
                {partner && <span className="presence-dot present" />}
              </div>
              {host && (
                <button
                  className="button invite-button full"
                  onClick={copyInvite}
                >
                  {copied ? (
                    <Check size={16} aria-hidden />
                  ) : (
                    <Copy size={16} aria-hidden />
                  )}
                  {copied ? "Invite copied" : "Copy private invite"}
                </button>
              )}
            </section>
            <section className="chat-panel" aria-label="Room chat">
              <div className="panel-heading">
                <h2>Chat</h2>
              </div>
              <div
                className="chat-messages"
                ref={chatLog}
                role="log"
                aria-live="polite"
                aria-relevant="additions"
              >
                {messages.length === 0 && (
                  <div className="chat-empty">
                    <p>No messages yet.</p>
                  </div>
                )}
                {messages.map((message) => (
                  <div
                    className={`chat-message ${message.role === role ? "own-message" : ""}`}
                    key={message.id}
                  >
                    <span>{message.role === role ? "You" : message.name}</span>
                    <p>{message.text}</p>
                  </div>
                ))}
              </div>
              <form
                className="chat-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    draft.trim() &&
                    send({ type: "chat", text: draft.trim() })
                  )
                    setDraft("");
                }}
              >
                <label className="sr-only" htmlFor="chat-message">
                  Message your partner
                </label>
                <input
                  id="chat-message"
                  placeholder="Message…"
                  maxLength={500}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={!connected}
                />
                <button
                  className="icon-button"
                  type="submit"
                  aria-label="Send message"
                  disabled={!connected || !draft.trim()}
                >
                  <Send size={17} aria-hidden />
                </button>
              </form>
            </section>
          </aside>
        </div>
      </main>
      <dialog
        ref={sourceDialog}
        className="source-dialog"
        aria-labelledby="source-title"
      >
        <button
          className="icon-button dialog-close"
          aria-label="Close source picker"
          onClick={() => sourceDialog.current?.close()}
        >
          <X size={20} aria-hidden />
        </button>
        <h2 id="source-title">Add a video</h2>
        <p>Paste a link below, or share a browser tab.</p>
        <form onSubmit={chooseSource}>
          <label htmlFor="video-url">YouTube or direct video link</label>
          <div className="source-input-wrap">
            <Link2 size={18} aria-hidden />
            <input
              id="video-url"
              type="url"
              placeholder="https://youtube.com/watch?v=…"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              required
              maxLength={2048}
              autoFocus
            />
          </div>
          <span className="input-hint">
            YouTube videos, Shorts, and HTTPS .mp4 / .webm files.
          </span>
          <button
            className="button button-primary full"
            disabled={!connected || sourcePending}
          >
            Load video <Play size={16} aria-hidden />
          </button>
        </form>
        <div className="or-divider">
          <span />
          OR
          <span />
        </div>
        <button
          className="screen-choice"
          onClick={shareScreen}
          disabled={!connected || sourcePending}
        >
          <span className="screen-choice-icon">
            <MonitorUp size={24} aria-hidden />
          </span>
          <span>
            <strong>
              {sourcePending
                ? "Choose a screen in your browser…"
                : "Share a tab or screen"}
            </strong>
            <small>For other websites and your own videos</small>
          </span>
          <ChevronRight size={18} aria-hidden />
        </button>
        <p className="screen-hint">
          For sound, choose a <strong>browser tab</strong> and enable{" "}
          <strong>Share tab audio</strong>. Some browsers and protected videos
          won’t allow audio or capture.
        </p>
        {sourceError && (
          <p className="form-error" role="alert">
            {sourceError}
          </p>
        )}
      </dialog>
    </div>
  );
}
