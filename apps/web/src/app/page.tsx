"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowRight, ArrowUpRight, LockKeyhole, X } from "lucide-react";
import { Brand } from "@/components/brand";
import { LilyScene } from "@/components/lily-scene";
import { createRoom } from "@/lib/room-client";
import { parseInvite } from "@/lib/protocol";
import { saveSession } from "@/lib/session";

gsap.registerPlugin(useGSAP);

export default function Home() {
  const scope = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ defaults: { ease: "power3.out" } })
          .from(".hero-copy > *", {
            y: 14,
            opacity: 0,
            duration: 0.55,
            stagger: 0.07,
          })
          .from(".hero-scene", { y: 18, opacity: 0, duration: 0.8 }, 0.12);
      });
      return () => media.revert();
    },
    { scope },
  );

  function open(nextMode: "create" | "join") {
    setMode(nextMode);
    setError("");
    dialog.current?.showModal();
  }

  async function enter(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const expires = Date.now() + 6 * 60 * 60 * 1000;
      if (mode === "create") {
        const room = await createRoom();
        saveSession(room.id, {
          token: room.host_token,
          invite: room.guest_token,
          name: name.trim(),
          expires,
        });
        router.push(`/room/${room.id}`);
      } else {
        const room = parseInvite(invite, window.location.origin);
        saveSession(room.id, { token: room.token, name: name.trim(), expires });
        router.push(`/room/${room.id}`);
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again.",
      );
      setPending(false);
    }
  }

  return (
    <div ref={scope} className="home-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="site-header">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="#how-it-works">
            How it works <ArrowUpRight size={14} aria-hidden />
          </a>
          <button
            className="button button-outline small"
            onClick={() => open("join")}
          >
            Join a room <ArrowRight size={15} aria-hidden />
          </button>
        </nav>
      </header>
      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <h1>
              Watch together.
              <br />
              <em>From anywhere.</em>
            </h1>
            <p className="hero-description">
              YouTube, a video link, or your screen. Watch and chat in a private
              room built for you and one other person.
            </p>
            <div className="hero-actions">
              <button
                className="button button-primary"
                onClick={() => open("create")}
              >
                Create a room <ArrowUpRight size={20} aria-hidden />
              </button>
              <span>
                No sign-up.
                <br />
                Just the two of you.
              </span>
            </div>
          </div>
          <div className="hero-scene" aria-hidden="true">
            <LilyScene className="lily-scene" />
          </div>
        </section>
        <section id="how-it-works" className="how-section">
          <h2>How it works</h2>
          <ol className="steps">
            <li>
              <h3>Start a room</h3>
              <p>
                Choose a YouTube video, a video file link, or share a browser
                tab.
              </p>
            </li>
            <li>
              <h3>Send the invite</h3>
              <p>
                Copy your private link and send it to the person joining you.
              </p>
            </li>
            <li>
              <h3>Press play</h3>
              <p>
                Watch and chat together. Switch to focus view when the film
                starts.
              </p>
            </li>
          </ol>
        </section>
      </main>
      <footer className="site-footer">
        <Brand />
        <span>YouTube · Video links · Screen sharing</span>
      </footer>
      <dialog
        ref={dialog}
        className="entry-dialog"
        aria-labelledby="entry-title"
        onCancel={() => {
          if (pending) setPending(false);
        }}
      >
        <button
          className="icon-button dialog-close"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          <X size={20} aria-hidden />
        </button>
        <h2 id="entry-title">
          {mode === "create" ? "Create a room" : "Join a room"}
        </h2>
        <p>
          {mode === "create"
            ? "Enter your name. You can invite someone on the next screen."
            : "Enter your name and paste the invite link you received."}
        </p>
        <form onSubmit={enter}>
          <label htmlFor="display-name">Your name</label>
          <input
            id="display-name"
            autoComplete="nickname"
            placeholder="Your first name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={32}
            pattern=".*\S.*"
            autoFocus
          />
          {mode === "join" && (
            <>
              <label htmlFor="invite-link">Your invite link</label>
              <input
                id="invite-link"
                type="url"
                placeholder="https://…/room/…#invite=…"
                value={invite}
                onChange={(event) => setInvite(event.target.value)}
                required
              />
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button button-primary full" disabled={pending}>
            {pending
              ? "Opening your room…"
              : mode === "create"
                ? "Create room"
                : "Join room"}
            <ArrowRight size={18} aria-hidden />
          </button>
        </form>
        <span className="dialog-footnote">
          <LockKeyhole size={12} aria-hidden /> Private invite · Two people · No
          account needed
        </span>
      </dialog>
    </div>
  );
}
