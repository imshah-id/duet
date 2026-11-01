import {
  Command,
  credentialsSchema,
  eventSchema,
  RoomEvent,
  type RoomState,
} from "./protocol";

export const apiUrl = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"
).replace(/\/$/, "");

export async function createRoom() {
  const response = await fetch(`${apiUrl}/rooms`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new Error(
      body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
        ? body.error
        : "Could not create a room. Please try again.",
    );
  }
  return credentialsSchema.parse(await response.json());
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export class RoomClient {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private latestState: RoomState | null = null;
  constructor(
    private readonly onEvent: (event: RoomEvent) => void,
    private readonly onStatus: (status: ConnectionStatus) => void,
  ) {}

  connect(id: string, token: string, name: string) {
    this.disconnect();
    this.onStatus("connecting");
    const gateway = process.env.NEXT_PUBLIC_WS_URL;
    const url = new URL(gateway || `/rooms/${id}/ws`, apiUrl);
    if (gateway) url.searchParams.set("room", id);
    else url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.latestState = null;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "auth", token, name }));
    socket.onmessage = ({ data }) => {
      if (
        this.socket !== socket ||
        typeof data !== "string" ||
        data.length > 65_536
      )
        return;
      try {
        let event = eventSchema.parse(JSON.parse(data));
        if (event.type === "welcome" || event.type === "state") {
          const { revision, snapshot_at } = event.state;
          const previous = this.latestState;
          if (
            previous &&
            (revision < previous.revision ||
              (revision === previous.revision &&
                (snapshot_at ?? 0) < (previous.snapshot_at ?? 0)))
          ) {
            if (event.type === "state") return;
            event = { ...event, state: previous };
          }
          this.latestState = event.state;
        }
        if (event.type === "welcome") {
          this.onStatus("connected");
          if (gateway && !this.heartbeat) {
            this.heartbeat = setInterval(() => {
              if (
                socket.readyState === WebSocket.OPEN &&
                socket.bufferedAmount <= 65_536
              )
                socket.send(JSON.stringify({ type: "heartbeat" }));
            }, 3_000);
          }
        }
        this.onEvent(event);
      } catch {
        this.onEvent({
          type: "error",
          message: "The server sent an unreadable message. Please reconnect.",
        });
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.socket = null;
      this.onStatus("disconnected");
    };
    socket.onerror = () =>
      this.onEvent({
        type: "error",
        message:
          "Could not reach the room. Check your connection and try again.",
      });
  }

  send(command: Command): boolean {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 65_536
    )
      return false;
    this.socket.send(JSON.stringify(command));
    return true;
  }

  disconnect() {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (!this.socket) return;
    const socket = this.socket;
    socket.onclose = null;
    socket.onmessage = null;
    socket.onerror = null;
    // Strict Mode may dispose an effect while the handshake is still pending.
    if (socket.readyState === WebSocket.CONNECTING)
      socket.onopen = () => socket.close();
    else socket.close();
    this.socket = null;
  }
}
