import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSource, parseInvite, eventSchema } from "./protocol";

test("recognizes YouTube formats and direct video, rejecting unsafe sources", () => {
  for (const url of [
    "https://youtu.be/aqz-KE-bpKQ",
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=2",
    "https://youtube.com/shorts/aqz-KE-bpKQ",
  ]) {
    assert.deepEqual(parseSource(url), { kind: "youtube", url: "aqz-KE-bpKQ" });
  }
  assert.equal(
    parseSource("https://example.com/video.mp4?signature=abc").kind,
    "video",
  );
  for (const url of [
    "javascript:alert(1)",
    "https://youtube.com.attacker.org/watch?v=aqz-KE-bpKQ",
    "http://example.com/a.mp4",
    "https://127.0.0.1/a.mp4",
    "https://user:pass@example.com/a.mp4",
    "https://example.com/page",
  ])
    assert.throws(() => parseSource(url));
});

test("invite links must belong to this app and carry a fragment credential", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const token = "a".repeat(32);
  assert.deepEqual(
    parseInvite(
      `https://duet.test/room/${id}#invite=${token}`,
      "https://duet.test",
    ),
    { id, token },
  );
  assert.throws(() =>
    parseInvite(
      `https://evil.test/room/${id}#invite=${token}`,
      "https://duet.test",
    ),
  );
  assert.throws(() =>
    parseInvite(
      `https://duet.test/room/${id}?invite=${token}`,
      "https://duet.test",
    ),
  );
});

test("runtime protocol validation rejects unsafe server sources", () => {
  assert.equal(
    eventSchema.safeParse({
      type: "state",
      state: {
        source: { kind: "video", url: "javascript:alert(1)" },
        playing: true,
        position: 0,
        revision: 1,
        members: [],
      },
    }).success,
    false,
  );
});
