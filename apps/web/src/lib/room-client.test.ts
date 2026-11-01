import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { RoomClient, type ConnectionStatus } from "./room-client";
import type { RoomEvent } from "./protocol";

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(event: RoomEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

function setup(context: TestContext, gateway?: string) {
  const originalSocket = globalThis.WebSocket;
  const originalGateway = process.env.NEXT_PUBLIC_WS_URL;
  if (gateway) process.env.NEXT_PUBLIC_WS_URL = gateway;
  else delete process.env.NEXT_PUBLIC_WS_URL;
  Socket.instances = [];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  context.mock.timers.enable({ apis: ["setInterval"] });
  const events: RoomEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const client = new RoomClient(
    (event) => events.push(event),
    (status) => statuses.push(status),
  );
  context.after(() => {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
    if (originalGateway === undefined) delete process.env.NEXT_PUBLIC_WS_URL;
    else process.env.NEXT_PUBLIC_WS_URL = originalGateway;
  });
  client.connect(
    "123e4567-e89b-42d3-a456-426614174000",
    "a".repeat(32),
    "Viewer",
  );
  return { client, socket: Socket.instances[0], events, statuses };
}

function snapshot(revision: number, snapshot_at?: number) {
  return {
    source: null,
    playing: false,
    position: 0,
    revision,
    snapshot_at,
    members: [],
  };
}

function welcome(revision = 1, snapshot_at?: number): RoomEvent {
  return {
    type: "welcome",
    role: "host",
    state: snapshot(revision, snapshot_at),
    ice_servers: [],
  };
}

test("gateway stage path is retained, credentials stay in first message, and heartbeat stops on disconnect", (context) => {
  const { client, socket, statuses } = setup(
    context,
    "wss://example.execute-api.us-east-1.amazonaws.com/production",
  );
  assert.equal(socket.url.pathname, "/production");
  assert.equal(
    socket.url.searchParams.get("room"),
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.equal(socket.url.searchParams.has("token"), false);
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: "auth",
    token: "a".repeat(32),
    name: "Viewer",
  });
  context.mock.timers.tick(3_000);
  assert.equal(socket.sent.length, 1, "No heartbeat before authentication");
  socket.receive(welcome());
  socket.receive(welcome());
  context.mock.timers.tick(3_000);
  assert.equal(
    socket.sent.length,
    2,
    "Repeated welcome must not add another timer",
  );
  assert.deepEqual(JSON.parse(socket.sent[1]), { type: "heartbeat" });
  assert.equal(statuses.at(-1), "connected");
  socket.close();
  context.mock.timers.tick(6_000);
  assert.equal(socket.sent.length, 2);
  assert.equal(statuses.at(-1), "disconnected");
  client.connect(
    "123e4567-e89b-42d3-a456-426614174000",
    "a".repeat(32),
    "Viewer",
  );
  const next = Socket.instances[1];
  next.open();
  next.receive(welcome());
  client.disconnect();
  context.mock.timers.tick(6_000);
  assert.equal(next.sent.length, 1);
});

test("native connection keeps its path without heartbeats and stale snapshots cannot roll back playback", (context) => {
  const { socket, events } = setup(context);
  assert.equal(
    socket.url.pathname,
    "/rooms/123e4567-e89b-42d3-a456-426614174000/ws",
  );
  assert.equal(socket.url.protocol, "ws:");
  socket.open();
  socket.receive({ type: "state", state: snapshot(3, 200) });
  socket.receive(welcome(2, 100));
  const joined = events.at(-1);
  assert.equal(joined?.type, "welcome");
  if (joined?.type === "welcome") assert.equal(joined.state.revision, 3);
  socket.receive({ type: "state", state: snapshot(2, 300) });
  socket.receive({ type: "state", state: snapshot(3, 199) });
  assert.equal(events.length, 2);
  socket.receive({ type: "state", state: snapshot(3, 201) });
  assert.equal(events.length, 3);
  socket.receive({ type: "state", state: snapshot(4) });
  assert.equal(events.length, 4, "Native snapshots need no timestamp");
  context.mock.timers.tick(9_000);
  assert.equal(socket.sent.length, 1);
});
