import { spawn } from "node:child_process";
import { root, rustEnv } from "./cargo.mjs";

const children = [
  spawn("cargo", ["run", "--manifest-path", `${root}server/Cargo.toml`], {
    env: rustEnv,
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    ["../../node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1"],
    {
      cwd: `${root}apps/web`,
      stdio: "inherit",
    },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 0));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
