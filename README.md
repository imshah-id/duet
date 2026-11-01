# Duet

A private watch room for two, built with Next.js, React, GSAP, and Rust/Axum.

The visual theme pairs custom vector lilies with crimson (`#DC143C`), deep wine surfaces, ivory petals, and rose highlights. Artwork is local SVG, fonts are self-hosted, and GSAP entrance motion respects reduced-motion preferences.

## Run locally

Requires Node.js 22+ and stable Rust. A project-local Rust toolchain was installed in `.tools/` on the development machine; the scripts automatically use it when present. On another machine, install Rust through [rustup](https://rust-lang.org/tools/install/).

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. Create a room, copy the private invite, and open it in another browser tab or browser. Use the same hostname for both viewers. The API listens at `127.0.0.1:4000`.

Optional settings: copy `.env.example` to `.env` for the API and `apps/web/.env.example` to `apps/web/.env.local` for the frontend. Root development commands load `.env`; Next.js loads its own environment file. Restart after changing settings. The public API URL must be set before a production frontend build.

## What works

| Source                                                  | Playback                                               | Audio                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| YouTube videos, Shorts, and video URLs for live streams | Official YouTube IFrame API; shared play, pause, seek  | Each viewer plays audio locally; each browser may need a click to allow playback                    |
| Public HTTPS MP4/WebM links                             | Native HTML video; shared play, pause, seek            | Native audio, with independent volume controls                                                      |
| Other sites / a browser tab / a screen                  | WebRTC screen video; host controls the captured source | Included **only if** the browser supplies an audio track; choose a tab and enable “Share tab audio” |

No arbitrary website iframe or server-side URL fetching. DRM, embed restrictions, codec support, signed-link expiry, regional restrictions, provider ads, and browser capture restrictions still apply. YouTube live-stream synchronization is best effort; exact seekable windows differ. This is not a service for bypassing provider restrictions.

The interface reports missing screen audio, media errors, disconnected sessions, and blocked autoplay. A local preview of your own screen is muted to prevent an echo. Your partner gets the captured audio track when available. Microphone and camera access are disabled.

The room adapts to phones, tablets, and desktops. **Hide chat** collapses the companion panel; **Focus view** gives the player the viewport; **Hide controls** removes playback controls with a persistent restore button. Escape exits focus view. View changes preserve the mounted video and screen stream.

## Structure and decisions

```text
apps/web/src/app/          Routes, global styles, request security policy
apps/web/src/components/   Landing artwork, watch room, native/YouTube players
apps/web/src/lib/          Validated protocol, room client, WebRTC session
server/src/room.rs         Room state and authorization rules
server/src/main.rs         HTTP, WebSocket lifecycle, resource limits
tests/rooms.test.ts        Two-client API integration test
scripts/                  Local process and toolchain launchers
```

`Room` owns server behavior through Rust methods. `RoomClient` and `ScreenSession` own browser connections and dispose of their sockets, timers, peers, and tracks. React owns presentation. There is no inheritance framework or dependency-injection container.

The server coordinates playback; **it never relays or stores video bytes**. YouTube/direct video is fetched by each browser. Screen media travels over WebRTC, directly or through your configured TURN relay. Room state uses monotonic time; clients correct playback drift over 1.25 seconds from snapshots sent every three seconds. This is approximate synchronization, not frame lock, and buffering/ads can cause divergence.

The initial service is intentionally one process, with capped in-memory rooms. No database is needed for ephemeral rooms. Restarting the API ends every room. For multiple instances, route a room to its owner or introduce a shared room coordinator before scaling horizontally.

## Security and memory boundaries

- Random UUID room IDs and separate random host/guest capabilities. The server compares capabilities in constant time and authorizes every room operation.
- Credentials are sent in the first WebSocket message, never query strings. Invites use URL fragments and are removed from the address bar after joining. Room capabilities are kept in tab-scoped session storage for reconnection, with a six-hour lifetime. XSS or a hostile extension can still read browser-held capabilities.
- Exactly one host and one guest connection per room. An invite is a bearer credential: anyone possessing it can take the free guest seat. Identity verification, one-time redemption, host approval, and invite rotation are not implemented.
- Exact CORS and WebSocket Origin allowlists; runtime JSON validation on both sides; host-only source selection and role-checked WebRTC signaling.
- 256 rooms, 512 total WebSockets, 32 queued events per room, 24 KiB WebSocket messages, 40 messages/second per socket, 5-second authentication/write timeouts. Slow consumers disconnect. The UI retains at most 80 chat messages.
- 5 room creations and 30 socket attempts per minute per direct peer IP; the IP map is capped at 4096 entries. Forwarded IP headers are intentionally not trusted. Behind a proxy, this limiter sees the proxy IP: configure edge limits and a trusted-proxy strategy before public rollout.
- Rooms expire after 30 minutes empty or six hours total. Cleanup runs every 30 seconds; active sessions also check expiry. Disconnects pause playback.
- Nonce-based script CSP, no inline script allowance in production, frame restrictions, no content sniffing, strict-origin referrers, no analytics or external fonts. The official YouTube API is loaded only when selected. It is third-party executable code; YouTube media requests and the configured STUN/TURN providers have their own privacy policies.
- Chat/signaling are visible to the coordination server; they are not end-to-end encrypted at the application level. HTTPS/WSS encrypt transport in production. WebRTC media uses its browser transport encryption. Direct peer connections can reveal network addresses to the invited peer; relay-only mode is not implemented.

Direct media URLs are restricted to HTTPS MP4/WebM paths without embedded credentials or IP-literal/local hostnames. Browsers still contact that media host, so invite only someone you trust. This is not a DNS allowlist or a guarantee against tracking by media providers.

## Checks

```sh
npm run check
npm test
npm run test:server
npm run build
# With the API running:
npm run test:integration
```

The tests cover viewing-mode transitions, screen audio/video track forwarding and cleanup, source/invite parsing, unsafe URLs, room admission, permission checks, invalid positions, expiration, disconnect cleanup, shared playback, chat, and WebRTC signal routing. They do not prove real-device audio/video quality or cross-network connectivity.

## Before deployment

Build the frontend with `npm run build`; start it with `npm run start -w apps/web`. Build the backend with `node scripts/cargo.mjs build --release --locked`; run `server/target/release/duet-server` with environment variables supplied by your service manager.

Serve both services behind HTTPS/WSS with exact `ALLOWED_ORIGINS`, reverse-proxy connection/request limits, WebSocket forwarding, and a 60-second-or-longer WebSocket idle timeout. Do not expose development servers. Configure a TURN service through `ICE_SERVERS_JSON` and test across mobile data and restrictive networks; STUN alone cannot guarantee a connection. Use short-lived per-session TURN credentials in a public deployment—the current environment configuration is static and is intended for initial testing, not a public relay credential service.

Verify two real devices for YouTube sound, MP4/WebM codecs, tab audio, blocked autoplay, denied capture, missing audio, remote mute, disconnect/reconnect, and source switching. No deployment, load benchmark, external security audit, or real-device audio test has been completed yet.

## Verified references

Framework package versions were checked against npm on November 2, 2026: Next.js 16.4.3, React 19.3.1, GSAP 3.15.0, and @gsap/react 2.1.2. Exact dependency resolutions are in `package-lock.json` and `server/Cargo.lock`.

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation) and [nonce-based CSP](https://nextjs.org/docs/app/guides/content-security-policy)
- [GSAP React lifecycle and cleanup](https://gsap.com/resources/React/)
- [Axum WebSocket limits](https://docs.rs/axum/latest/axum/extract/struct.WebSocketUpgrade.html)
- [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference)
- [Browser screen capture and audio constraints](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [OWASP WebSocket security guidance](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
