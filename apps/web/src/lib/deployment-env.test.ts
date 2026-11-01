import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const valid = {
  VERCEL: "1",
  NEXT_PUBLIC_API_URL: "https://http-id.execute-api.us-east-1.amazonaws.com",
  NEXT_PUBLIC_WS_URL:
    "wss://ws-id.execute-api.us-east-1.amazonaws.com/production",
};

function loadConfig(environment: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      "await import('./apps/web/next.config.ts')",
    ],
    {
      cwd: root,
      env: { ...process.env, ...environment },
      encoding: "utf8",
    },
  );
}

test("Vercel builds require public HTTPS and WSS endpoints; local builds keep their defaults", () => {
  assert.equal(loadConfig(valid).status, 0);
  assert.equal(
    loadConfig({ VERCEL: "", NEXT_PUBLIC_API_URL: "", NEXT_PUBLIC_WS_URL: "" })
      .status,
    0,
  );
  for (const [name, value] of [
    ["NEXT_PUBLIC_API_URL", ""],
    ["NEXT_PUBLIC_WS_URL", ""],
    ["NEXT_PUBLIC_API_URL", "http://api.example.com"],
    ["NEXT_PUBLIC_WS_URL", "https://ws.example.com"],
    ["NEXT_PUBLIC_API_URL", "https://localhost"],
    ["NEXT_PUBLIC_API_URL", "https://127.0.0.1"],
    ["NEXT_PUBLIC_WS_URL", "wss://service.local"],
    ["NEXT_PUBLIC_API_URL", "https://user:secret@api.example.com"],
    ["NEXT_PUBLIC_WS_URL", "wss://ws.example.com/production?token=secret"],
  ]) {
    const result = loadConfig({ ...valid, [name]: value });
    assert.notEqual(result.status, 0, `${name} must reject ${value}`);
    assert.ok(result.stderr.includes(`${name} must be a public`));
  }
});
