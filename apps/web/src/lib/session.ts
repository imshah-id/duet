import { z } from "zod";

const sessionSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{32}$/),
  invite: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  name: z.string().max(32).optional(),
  expires: z.number(),
});
export type RoomSession = z.infer<typeof sessionSchema>;

// shortcut: room capabilities live in tab-scoped storage for at most six hours; use HttpOnly sessions when accounts are introduced.
export function saveSession(id: string, session: RoomSession) {
  sessionStorage.setItem(
    `duet:${id}`,
    JSON.stringify(sessionSchema.parse(session)),
  );
}

export function readSession(id: string): RoomSession | null {
  try {
    const session = sessionSchema.parse(
      JSON.parse(sessionStorage.getItem(`duet:${id}`) ?? "null"),
    );
    if (session.expires > Date.now()) return session;
    sessionStorage.removeItem(`duet:${id}`);
  } catch {
    /* Invalid or unavailable storage is treated as a missing invite. */
  }
  return null;
}
