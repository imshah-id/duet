import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import {
  credentialsSchema,
  eventSchema,
  type RoomEvent,
} from "../apps/web/src/lib/protocol";

const api = process.env.TEST_API_URL ?? "http://127.0.0.1:4000";
const origin = "http://localhost:3000";

class TestPeer {
  readonly socket: WebSocket;
  private events: RoomEvent[] = [];
  constructor(id: string, token: string) {
    this.socket = new WebSocket(`${api.replace("http", "ws")}/rooms/${id}/ws`, {
      origin,
    });
    this.socket.on("open", () =>
      this.send({ type: "auth", token, name: "Test viewer" }),
    );
    this.socket.on("message", (data) =>
      this.events.push(eventSchema.parse(JSON.parse(data.toString()))),
    );
  }
  send(value: unknown) {
    this.socket.send(JSON.stringify(value));
  }
  async wait(predicate: (event: RoomEvent) => boolean): Promise<RoomEvent> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const index = this.events.findIndex(predicate);
      if (index !== -1) return this.events.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error("Expected event not received");
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

test(
  "room isolation, origin checks, admission, shared controls, chat, signals, and reconnect",
  { timeout: 20_000 },
  async () => {
    const forbidden = await fetch(`${api}/rooms`, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(forbidden.status, 403);
    const response = await fetch(`${api}/rooms`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const room = credentialsSchema.parse(await response.json());
    const otherResponse = await fetch(`${api}/rooms`, {
      method: "POST",
      headers: { Origin: origin },
    });
    const otherRoom = credentialsSchema.parse(await otherResponse.json());
    const crossRoom = new TestPeer(otherRoom.id, room.host_token);
    await crossRoom.wait(
      (e) => e.type === "error" && e.message.includes("invalid"),
    );
    await crossRoom.close();
    const bad = new TestPeer(room.id, "0".repeat(32));
    await bad.wait((e) => e.type === "error");
    await bad.close();
    const host = new TestPeer(room.id, room.host_token);
    const guest = new TestPeer(room.id, room.guest_token);
    try {
      await host.wait((e) => e.type === "welcome" && e.role === "host");
      await guest.wait((e) => e.type === "welcome" && e.role === "guest");
      await host.wait(
        (e) => e.type === "state" && e.state.members.length === 2,
      );
      const third = new TestPeer(room.id, room.guest_token);
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
      await guest.close();
      await host.wait(
        (e) => e.type === "state" && e.state.members.length === 1,
      );
      const returning = new TestPeer(room.id, room.guest_token);
      await returning.wait((e) => e.type === "welcome");
      await returning.close();
    } finally {
      await host.close();
      await guest.close();
    }
  },
);
