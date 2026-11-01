import { z } from "zod";

export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("youtube"),
    url: z.string().regex(/^[\w-]{11}$/),
  }),
  z.object({
    kind: z.literal("video"),
    url: z.string().max(2048).refine(isVideoUrl),
  }),
  z.object({ kind: z.literal("screen") }),
]);
export type Source = z.infer<typeof sourceSchema>;
export const roleSchema = z.enum(["host", "guest"]);
export type Role = z.infer<typeof roleSchema>;
const stateSchema = z.object({
  source: sourceSchema.nullable(),
  playing: z.boolean(),
  position: z.number().nonnegative(),
  revision: z.number().int().nonnegative(),
  snapshot_at: z.number().int().nonnegative().nullable().optional(),
  members: z
    .array(z.object({ role: roleSchema, name: z.string().max(128) }))
    .max(2),
});
export type RoomState = z.infer<typeof stateSchema>;
export const signalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string().max(16_384) }),
  z.object({ kind: z.literal("answer"), sdp: z.string().max(16_384) }),
  z.object({
    kind: z.literal("ice"),
    candidate: z.string().max(4096),
    sdp_mid: z.string().nullable(),
    sdp_m_line_index: z.number().int().nullable(),
  }),
]);
export type Signal = z.infer<typeof signalSchema>;
export const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    role: roleSchema,
    state: stateSchema,
    ice_servers: z
      .array(
        z.object({
          urls: z.union([z.string(), z.array(z.string())]),
          username: z.string().optional(),
          credential: z.string().optional(),
        }),
      )
      .max(8),
  }),
  z.object({ type: z.literal("state"), state: stateSchema }),
  z.object({
    type: z.literal("chat"),
    id: z.string().uuid(),
    role: roleSchema,
    name: z.string(),
    text: z.string().max(2000),
  }),
  z.object({
    type: z.literal("signal"),
    from: roleSchema,
    signal: signalSchema,
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("expired") }),
]);
export type RoomEvent = z.infer<typeof eventSchema>;
export type ChatMessage = Extract<RoomEvent, { type: "chat" }>;
export type Command =
  | { type: "source"; source: Source | null }
  | { type: "playback"; playing: boolean; position: number }
  | { type: "chat"; text: string }
  | { type: "signal"; signal: Signal };

export const credentialsSchema = z.object({
  id: z.string().uuid(),
  host_token: z.string().regex(/^[a-f0-9]{32}$/),
  guest_token: z.string().regex(/^[a-f0-9]{32}$/),
});

export function isVideoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname.includes(".") &&
      !url.hostname.endsWith(".local") &&
      !url.hostname.endsWith(".localhost") &&
      !/^[\d.]+$/.test(url.hostname) &&
      !url.hostname.includes(":") &&
      /\.(mp4|webm)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function parseSource(value: string): Source {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Paste a complete HTTPS video link.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Use an HTTPS link without embedded credentials.");
  const host = url.hostname;
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "www.youtube-nocookie.com",
    ].includes(host)
  ) {
    id =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : (/^\/(shorts|embed|live)\/([\w-]+)$/.exec(url.pathname)?.[2] ?? null);
  }
  if (id && /^[\w-]{11}$/.test(id)) return { kind: "youtube", url: id };
  if (isVideoUrl(url.href)) return { kind: "video", url: url.href };
  throw new Error(
    "Use a YouTube or direct .mp4/.webm link. For another site, choose Share a screen.",
  );
}

export function parseInvite(
  value: string,
  origin: string,
): { id: string; token: string } {
  const url = new URL(value.trim(), origin);
  const id = /^\/room\/([a-f\d-]+)$/.exec(url.pathname)?.[1];
  const token = new URLSearchParams(url.hash.slice(1)).get("invite");
  if (
    url.origin !== origin ||
    !z.string().uuid().safeParse(id).success ||
    !token ||
    !/^[a-f0-9]{32}$/.test(token)
  )
    throw new Error("Paste a complete Duet invite link from your host.");
  return { id: id!, token };
}

export function formatTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
