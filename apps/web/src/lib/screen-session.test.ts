import { test } from "node:test";
import assert from "node:assert/strict";
import { ScreenSession } from "./screen-session";
import type { Signal } from "./protocol";

class TestPeerConnection {
  static instances: TestPeerConnection[] = [];
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  tracks: MediaStreamTrack[] = [];
  candidates: RTCIceCandidateInit[] = [];
  closed = false;
  constructor() {
    TestPeerConnection.instances.push(this);
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
  async createOffer() {
    return { type: "offer", sdp: "offer-with-tracks" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "answer-with-tracks" };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    this.remoteDescription = description;
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.candidates.push(candidate);
  }
  close() {
    this.closed = true;
  }
}

test("screen session forwards video AND audio and releases both on close", async () => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection =
    TestPeerConnection as unknown as typeof RTCPeerConnection;
  try {
    const stopped: string[] = [];
    const tracks = ["video", "audio"].map((kind) => ({
      kind,
      onended: null,
      stop: () => stopped.push(kind),
    })) as unknown as MediaStreamTrack[];
    const stream = { getTracks: () => tracks } as MediaStream;
    const signals: Signal[] = [];
    const session = new ScreenSession(
      [],
      (signal) => signals.push(signal),
      () => {},
      () => {},
    );
    session.setStream(stream);
    await session.offer();
    const peer = TestPeerConnection.instances.at(-1)!;
    assert.deepEqual(
      peer.tracks.map((track) => track.kind),
      ["video", "audio"],
    );
    assert.equal(signals[0].kind, "offer");
    session.close();
    assert.equal(peer.closed, true);
    assert.deepEqual(stopped, ["video", "audio"]);
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
});

test("early ICE waits for the offer, and stale queued signals cannot reopen a closed session", async () => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection =
    TestPeerConnection as unknown as typeof RTCPeerConnection;
  try {
    const signals: Signal[] = [];
    const session = new ScreenSession(
      [],
      (signal) => signals.push(signal),
      () => {},
      () => {},
    );
    await session.receive({
      kind: "ice",
      candidate: "candidate",
      sdp_mid: "0",
      sdp_m_line_index: 0,
    });
    await session.receive({ kind: "offer", sdp: "remote offer" });
    const peer = TestPeerConnection.instances.at(-1)!;
    assert.equal(peer.candidates.length, 1);
    assert.equal(signals[0].kind, "answer");
    const count = TestPeerConnection.instances.length;
    const pending = session.receive({ kind: "offer", sdp: "stale offer" });
    session.close();
    await pending;
    assert.equal(TestPeerConnection.instances.length, count);
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
});
