import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const localCargo = `${root}.tools/cargo`;
export const rustEnv = existsSync(`${localCargo}/bin/cargo`)
  ? {
      ...process.env,
      CARGO_HOME: localCargo,
      RUSTUP_HOME: `${root}.tools/rustup`,
      PATH: `${localCargo}/bin:${process.env.PATH}`,
    }
  : process.env;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn(
    "cargo",
    [
      process.argv[2],
      "--manifest-path",
      `${root}server/Cargo.toml`,
      ...process.argv.slice(3),
    ],
    { env: rustEnv, stdio: "inherit" },
  );
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
