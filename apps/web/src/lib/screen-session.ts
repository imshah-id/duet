import type { Signal } from "./protocol";

export class ScreenSession {
  private peer: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private stream: MediaStream | null = null;
  private signalQueue: Promise<void> = Promise.resolve();
  private pendingSignals = 0;
  private generation = 0;

  constructor(
    private readonly iceServers: RTCIceServer[],
    private readonly send: (signal: Signal) => void,
    private readonly onStream: (stream: MediaStream | null) => void,
    private readonly onStatus: (status: string) => void,
  ) {}

  private makePeer() {
    this.peer?.close();
    const peer = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peer = peer;
    peer.onicecandidate = ({ candidate }) => {
      if (candidate && this.peer === peer)
        this.send({
          kind: "ice",
          candidate: candidate.candidate,
          sdp_mid: candidate.sdpMid,
          sdp_m_line_index: candidate.sdpMLineIndex,
        });
    };
    peer.ontrack = ({ streams }) => {
      if (streams[0] && this.peer === peer) this.onStream(streams[0]);
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      if (peer.connectionState === "connected")
        this.onStatus("Screen connected");
      else if (["failed", "disconnected"].includes(peer.connectionState))
        this.onStatus(
          "Screen connection interrupted. Ask the host to restart sharing.",
        );
    };
    return peer;
  }

  setStream(stream: MediaStream) {
    this.stream = stream;
    this.onStream(stream);
  }

  async offer() {
    if (!this.stream) return;
    this.pendingIce = [];
    const peer = this.makePeer();
    for (const track of this.stream.getTracks())
      peer.addTrack(track, this.stream);
    await peer.setLocalDescription(await peer.createOffer());
    if (this.peer !== peer) return;
    if (peer.localDescription)
      this.send({ kind: "offer", sdp: peer.localDescription.sdp });
    this.onStatus("Connecting screen…");
  }

  receive(signal: Signal) {
    if (this.pendingSignals >= 64) return Promise.resolve();
    this.pendingSignals += 1;
    const generation = this.generation;
    this.signalQueue = this.signalQueue
      .then(() =>
        generation === this.generation ? this.applySignal(signal) : undefined,
      )
      .catch(() => {
        if (generation === this.generation)
          this.onStatus(
            "Screen connection failed. Ask the host to restart sharing.",
          );
      })
      .finally(() => {
        this.pendingSignals -= 1;
      });
    return this.signalQueue;
  }

  private async applySignal(signal: Signal) {
    if (signal.kind === "offer") {
      const peer = this.makePeer();
      await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      await this.flushIce(peer);
      await peer.setLocalDescription(await peer.createAnswer());
      if (this.peer === peer && peer.localDescription)
        this.send({ kind: "answer", sdp: peer.localDescription.sdp });
    } else if (signal.kind === "answer") {
      const peer = this.peer;
      if (!peer) return;
      await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      await this.flushIce(peer);
    } else {
      const candidate = {
        candidate: signal.candidate,
        sdpMid: signal.sdp_mid,
        sdpMLineIndex: signal.sdp_m_line_index,
      };
      if (this.peer?.remoteDescription)
        await this.peer.addIceCandidate(candidate);
      else if (this.pendingIce.length < 64) this.pendingIce.push(candidate);
    }
  }

  private async flushIce(peer: RTCPeerConnection) {
    for (const candidate of this.pendingIce)
      await peer.addIceCandidate(candidate);
    this.pendingIce = [];
  }

  resetPeer() {
    this.generation += 1;
    this.peer?.close();
    this.peer = null;
    this.pendingIce = [];
  }

  close() {
    this.resetPeer();
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.stream = null;
    this.onStream(null);
  }
}
