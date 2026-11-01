import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import {
  credentialsSchema,
  eventSchema,
  type RoomEvent,
} from "../apps/web/src/lib/protocol";

const api = (process.env.TEST_API_URL ?? "http://127.0.0.1:4000").replace(
  /\/$/,
  "",
);
const origin = process.env.TEST_ORIGIN ?? "http://localhost:3000";
const gateway = process.env.TEST_WS_URL;

class TestPeer {
  readonly socket: WebSocket;
  private events: RoomEvent[] = [];
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private failure: Error | null = null;
  revision = -1;
  constructor(id: string, token: string) {
    const url = gateway
      ? new URL(gateway)
      : new URL(`${api.replace("http", "ws")}/rooms/${id}/ws`);
    if (gateway) url.searchParams.set("room", id);
    this.socket = new WebSocket(url, { origin });
    this.socket.on("open", () =>
      this.send({ type: "auth", token, name: "Test viewer" }),
    );
    this.socket.on("message", (data) => {
      try {
        const event = eventSchema.parse(JSON.parse(data.toString()));
        if (event.type === "welcome" || event.type === "state")
          this.revision = Math.max(this.revision, event.state.revision);
        if (gateway && event.type === "welcome" && !this.heartbeat) {
          this.heartbeat = setInterval(() => {
            if (this.socket.readyState === WebSocket.OPEN)
              this.send({ type: "heartbeat" });
          }, 3_000);
        }
        this.events.push(event);
      } catch {
        this.failure = new Error(
          "The WebSocket returned an invalid protocol frame.",
        );
        this.socket.terminate();
      }
    });
    this.socket.on("error", (error) => {
      this.failure = error;
    });
    this.socket.on("close", () => clearInterval(this.heartbeat));
  }
  send(value: unknown) {
    this.socket.send(JSON.stringify(value));
  }
  async wait(
    predicate: (event: RoomEvent) => boolean,
    timeout = gateway ? 15_000 : 4000,
  ): Promise<RoomEvent> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const index = this.events.findIndex(predicate);
      if (index !== -1) return this.events.splice(index, 1)[0];
      if (this.failure) throw this.failure;
      if (this.socket.readyState === WebSocket.CLOSED)
        throw new Error("The WebSocket closed before the expected event.");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error("Expected event not received");
  }
  async close() {
    clearInterval(this.heartbeat);
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => this.socket.terminate(), 2_000);
      this.socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.close();
    });
  }
}

test(
  "room isolation, origin checks, admission, shared controls, chat, signals, and reconnect",
  { timeout: gateway ? 180_000 : 20_000 },
  async (context) => {
    const peers: TestPeer[] = [];
    const connect = (id: string, token: string) => {
      const peer = new TestPeer(id, token);
      peers.push(peer);
      return peer;
    };
    context.after(async () => {
      await Promise.all(peers.map((peer) => peer.close()));
    });
    const forbidden = await fetch(`${api}/rooms`, {
      method: "POST",
      signal: AbortSignal.timeout(gateway ? 15_000 : 4_000),
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(forbidden.status, 403);
    const response = await fetch(`${api}/rooms`, {
      method: "POST",
      signal: AbortSignal.timeout(gateway ? 15_000 : 4_000),
      headers: { Origin: origin },
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const room = credentialsSchema.parse(await response.json());
    const otherResponse = await fetch(`${api}/rooms`, {
      method: "POST",
      signal: AbortSignal.timeout(gateway ? 15_000 : 4_000),
      headers: { Origin: origin },
    });
    assert.equal(otherResponse.status, 201);
    const otherRoom = credentialsSchema.parse(await otherResponse.json());
    const crossRoom = connect(otherRoom.id, room.host_token);
    await crossRoom.wait(
      (e) => e.type === "error" && e.message.includes("invalid"),
    );
    await crossRoom.close();
    const bad = connect(room.id, "0".repeat(32));
    await bad.wait((e) => e.type === "error");
    await bad.close();
    const host = connect(room.id, room.host_token);
    const guest = connect(room.id, room.guest_token);
    try {
      await host.wait((e) => e.type === "welcome" && e.role === "host");
      await guest.wait((e) => e.type === "welcome" && e.role === "guest");
      await host.wait(
        (e) => e.type === "state" && e.state.members.length === 2,
      );
      const third = connect(room.id, room.guest_token);
      assert.match(
        (
          (await third.wait((e) => e.type === "error")) as Extract<
            RoomEvent,
            { type: "error" }
          >
        ).message,
        /seat is already/,
      );
      await third.close();
      guest.send({
        type: "source",
        source: { kind: "youtube", url: "aqz-KE-bpKQ" },
      });
      await guest.wait(
        (e) => e.type === "error" && e.message.includes("Only the host"),
      );
      host.send({
        type: "source",
        source: { kind: "youtube", url: "aqz-KE-bpKQ" },
      });
      await guest.wait(
        (e) => e.type === "state" && e.state.source?.kind === "youtube",
      );
      guest.send({ type: "playback", playing: true, position: 42 });
      await host.wait(
        (e) => e.type === "state" && e.state.playing && e.state.position >= 42,
      );
      host.send({ type: "playback", playing: false, position: 45 });
      await guest.wait(
        (e) =>
          e.type === "state" && !e.state.playing && e.state.position === 45,
      );
      guest.send({ type: "chat", text: "<script>not executable</script>" });
      await host.wait(
        (e) =>
          e.type === "chat" && e.text === "<script>not executable</script>",
      );
      host.send({ type: "playback", playing: true, position: -1 });
      await host.wait(
        (e) => e.type === "error" && e.message.includes("position"),
      );
      host.send({ type: "source", source: { kind: "screen" } });
      await guest.wait(
        (e) => e.type === "state" && e.state.source?.kind === "screen",
      );
      host.send({
        type: "signal",
        signal: { kind: "offer", sdp: "test offer" },
      });
      await guest.wait((e) => e.type === "signal" && e.signal.kind === "offer");
      guest.send({
        type: "signal",
        signal: { kind: "answer", sdp: "test answer" },
      });
      await host.wait((e) => e.type === "signal" && e.signal.kind === "answer");
      guest.send({
        type: "signal",
        signal: { kind: "offer", sdp: "not allowed" },
      });
      await guest.wait(
        (e) => e.type === "error" && e.message.includes("signal"),
      );
      const beforeVideo = guest.revision;
      host.send({
        type: "source",
        source: { kind: "youtube", url: "aqz-KE-bpKQ" },
      });
      await guest.wait(
        (e) =>
          e.type === "state" &&
          e.state.source?.kind === "youtube" &&
          e.state.revision > beforeVideo,
      );
      host.send({ type: "playback", playing: true, position: 10 });
      await host.wait(
        (e) =>
          e.type === "state" &&
          e.state.playing &&
          e.state.position >= 10 &&
          e.state.position < 20,
      );
      const beforeDeparture = host.revision;
      await guest.close();
      // API Gateway disconnect delivery is best effort; heartbeats also reap the 60-second seat lease.
      await host.wait(
        (e) =>
          e.type === "state" &&
          e.state.revision > beforeDeparture &&
          e.state.members.length === 1 &&
          !e.state.playing,
        gateway ? 75_000 : 4_000,
      );
      const returning = connect(room.id, room.guest_token);
      await returning.wait((e) => e.type === "welcome");
      await returning.close();
    } finally {
      await host.close();
      await guest.close();
    }
  },
);
