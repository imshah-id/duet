import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

test("CSP permits distinct HTTP and WebSocket origins without allowing every AWS endpoint", (context) => {
  const originalApi = process.env.NEXT_PUBLIC_API_URL;
  const originalSocket = process.env.NEXT_PUBLIC_WS_URL;
  process.env.NEXT_PUBLIC_API_URL =
    "https://http-id.execute-api.us-east-1.amazonaws.com";
  process.env.NEXT_PUBLIC_WS_URL =
    "wss://socket-id.execute-api.us-east-1.amazonaws.com/production";
  context.after(() => {
    if (originalApi === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalApi;
    if (originalSocket === undefined) delete process.env.NEXT_PUBLIC_WS_URL;
    else process.env.NEXT_PUBLIC_WS_URL = originalSocket;
  });
  const response = proxy(new NextRequest("https://duet.example/"));
  const policy = response.headers.get("Content-Security-Policy") ?? "";
  assert.match(
    policy,
    /connect-src 'self' https:\/\/http-id\.execute-api\.us-east-1\.amazonaws\.com wss:\/\/socket-id\.execute-api\.us-east-1\.amazonaws\.com(?: |;)/,
  );
  assert.equal(policy.includes("*.amazonaws.com"), false);
  assert.match(policy, /script-src 'self' 'nonce-[^']+'/);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});
