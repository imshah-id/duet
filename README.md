# Duet

A private watch room for two. Next.js and React provide the interface; Rust coordinates playback, chat, and WebRTC signaling. The interface uses crimson accents, local lily artwork, self-hosted fonts, and reduced-motion-aware animation.

## Run locally

Use Node.js 24 and stable Rust. The launcher uses a project-local `.tools/` Rust toolchain when present; otherwise it uses Rust from `PATH`.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. The native Rust API listens at `127.0.0.1:4000`. Create a room and open its invite in another browser or tab. Both viewers must use the same frontend hostname.

Optional configuration: copy `.env.example` to `.env` and `apps/web/.env.example` to `apps/web/.env.local`. Leave `NEXT_PUBLIC_WS_URL` unset for the native backend. Restart after changing settings.

## Playback

| Source                                      | Playback                                          | Audio                                                                                      |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| YouTube videos, Shorts, and live-video URLs | Official IFrame API; shared play, pause, and seek | Each browser plays its own audio                                                           |
| Public HTTPS MP4/WebM links                 | Native video; shared play, pause, and seek        | Independent local volume                                                                   |
| Other websites or a shared screen           | WebRTC capture; host controls the source          | Only when the browser supplies an audio track; select a tab and enable **Share tab audio** |

The coordination backend never fetches, stores, or relays video. WebRTC media travels directly between browsers or through a configured TURN relay. Camera and microphone access are disabled. DRM, embedding restrictions, browser capture support, codecs, ads, and regional restrictions still apply.

Synchronization is approximate: clients correct drift over 1.25 seconds from periodic snapshots. YouTube live streams and buffering can diverge. **Hide chat**, **Focus view**, and **Hide controls** preserve the mounted player; Escape exits focus view.

## Backend runtimes

|                  | Local/native            | AWS Lambda                                             |
| ---------------- | ----------------------- | ------------------------------------------------------ |
| Entry point      | `server/src/main.rs`    | `server/src/bin/lambda.rs`                             |
| Connections      | Axum WebSockets         | API Gateway WebSocket API                              |
| Room state       | Process memory          | DynamoDB, conditional writes and atomic seat admission |
| Restart behavior | All rooms end           | Room state survives Lambda cold starts and deployments |
| Timekeeping      | Monotonic process clock | Persisted epoch timestamps and playback anchors        |

Lambda has a separate HTTP API for `POST /rooms` and `GET /health`. WebSockets connect with a nonsecret `?room=<uuid>` parameter; the token is sent in the first message. Authenticated clients send a heartbeat every three seconds to renew their seat and obtain playback snapshots. Snapshot revisions and timestamps prevent older deliveries from replacing newer state.

Lambda room records expire after six hours, or after 30 minutes empty. Seats have 60-second leases; missed disconnects are reaped during the next room operation. Pending authentication expires after 15 seconds. Application code enforces these deadlines even before DynamoDB's asynchronous TTL deletion. Chat and WebRTC signals are forwarded without being stored as message history.

API Gateway closes WebSockets after [two hours](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html). Use **Reconnect** when disconnected; this is not an automatic reconnect loop. A silent unauthenticated socket can remain open until the gateway idle timeout, but cannot occupy a room seat or issue authenticated commands.

## Deploy

The deployment uses **us-east-1**. The **duet-bootstrap** CloudFormation stack provisions deployment access and API identities. The Vercel project **duet** is connected to `imshah-id/duet`, with root directory **apps/web**, Node.js **24**, and production domain **duet-green.vercel.app**. Production promotion is gated by the GitHub **check** and **deploy-backend** jobs.

1. An AWS administrator creates the **duet-bootstrap** CloudFormation stack from `infra/bootstrap.json`, acknowledging its named IAM resources. It creates the artifact bucket, HTTP/WebSocket API identities, Lambda runtime role, and GitHub deploy role. Set `AllowedOrigins` to the exact frontend origin. If the account already has the GitHub OIDC provider, supply its ARN as `ExistingGitHubOidcArn`.
2. Set GitHub repository variables **AWS_DEPLOY_ROLE_ARN** to the bootstrap output `DeployRoleArn`, and **DUET_ALLOWED_ORIGINS** to `https://duet-green.vercel.app` (or an exact comma-separated origin list, without trailing slashes). Keep the bootstrap HTTP API's CORS origins and this variable aligned when adding domains.
3. Push to `main` or run the **Check** workflow manually. After all checks pass, it builds an x86-64 musl Rust executable, packages it as `bootstrap.zip`, uploads a commit-addressed artifact, and deploys **duet-backend** from `infra/backend.json`. Deployment requires both variables; missing configuration fails the production job. The workflow summary reports `HttpApiUrl` and `WebSocketUrl` and checks `/health` plus room admission, synchronization, chat, and signaling against the deployed APIs.
4. These **Production** environment variables are configured in Vercel. For a replacement backend, update them using the workflow's outputs before building:

   ```text
   NEXT_PUBLIC_API_URL=https://5nygeot0hb.execute-api.us-east-1.amazonaws.com
   NEXT_PUBLIC_WS_URL=wss://rbufml5rzj.execute-api.us-east-1.amazonaws.com/prod
   ```

5. Push `main` to trigger the Vercel Git integration. GitHub Deployment Checks hold the production alias until **check** and **deploy-backend** pass. Test a two-browser room after promotion. These public URLs are embedded at build time; changing them requires a new frontend deployment. Vercel builds reject absent or invalid endpoints. Preview domains need their own explicit backend origin allowance.

For CLI deployments, `.vercelignore` permits only the frontend and npm workspace metadata. Run `vercel deploy --dry --json` to inspect the upload manifest before deploying.

GitHub assumes the deploy role through OIDC, restricted to `imshah-id/duet` on `main`, including its immutable owner and repository IDs; no AWS access keys are stored in GitHub. Pull requests run checks without production deployment credentials. The deploy role can manage the Duet resources and pass only the Duet runtime role; it cannot create arbitrary IAM roles.

The backend stack provisions a 512 MB, 15-second Lambda using `provided.al2023`, an on-demand DynamoDB table, and API stages. HTTP throttling is 10 requests/second with a burst of 20; WebSocket throttling is 50 requests/second with a burst of 100. CloudWatch log retention is 14 days. The table and artifact bucket are retained when their stacks are removed; a failed initial table creation is rolled back to avoid orphaning an unused table. Artifact objects expire after 30 days.

Each connected viewer generates about 20 heartbeat Lambda invocations per minute, plus commands. Heartbeats also perform DynamoDB operations and WebSocket sends. Two viewers therefore produce about 40 heartbeat invocations per minute per room. API throttling is not a spending cap; monitor AWS usage and configure account budgets.

Configure TURN through the backend's `IceServersJson` CloudFormation parameter (`ICE_SERVERS_JSON` at runtime), then test across mobile data and restrictive networks. STUN alone does not guarantee connectivity. Static TURN credentials are suitable for initial testing; a public deployment needs short-lived credentials. Coordinate parameter changes with the deployment workflow so subsequent releases preserve the intended configuration.

## Security and limits

- One host and one guest per room, with separate random capabilities and role checks on every operation. Only the host can choose a source. Anyone holding an invite can claim the available guest seat; identity verification and invite rotation are not implemented.
- Invite tokens use URL fragments, are removed from the address bar after entry, and remain in tab-scoped session storage for up to six hours. XSS or a hostile extension can still read them.
- Exact Origin/CORS allowlists, nonce-based script CSP, typed protocol validation, 24 KiB incoming messages, and 40 messages/second per authenticated connection. The browser retains at most 80 chat messages.
- Room creation is limited to five requests and connection attempts to 30 requests per IP per minute. Lambda uses API Gateway's client IP and DynamoDB counters. Native mode uses the direct socket peer; a reverse proxy requires a trusted-IP strategy and edge limits.
- Native mode additionally caps rooms at 256, WebSockets at 512, the admission map at 4096 entries, and queued events at 32 per room; authentication and writes time out after five seconds. These process-memory caps do not apply to DynamoDB-backed Lambda rooms.
- HTTPS/WSS protects production transport. Chat and signaling are visible to the coordination backend; they are not application-level end-to-end encrypted. WebRTC encrypts media transport, but direct peers may learn each other's network addresses.
- Direct video URLs must be public HTTPS MP4/WebM paths without credentials or IP-literal/local hostnames. Browsers contact the media provider; this is not a DNS allowlist or protection against provider tracking. YouTube and STUN/TURN providers have their own privacy policies.

## Checks

```sh
npm run check
npm test
npm run test:server
npm run build
node scripts/cargo.mjs test --features lambda --locked
# With the native API running:
npm run test:integration
# With DynamoDB Local running:
DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 node scripts/cargo.mjs test --features lambda --bin duet-lambda --locked -- --ignored
```

Checks cover protocol validation, authorization, playback, chat, signaling, connection cleanup, persisted state, concurrent DynamoDB seat admission, and stale-connection isolation. Local tests do not establish deployed AWS behavior, real-device screen audio, cross-network media quality, load capacity, or a complete external security audit.
