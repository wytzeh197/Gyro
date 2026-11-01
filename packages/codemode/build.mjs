import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const rustTarget =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  (process.platform === "darwin"
    ? process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin"
    : "");
const targets = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
};
if (!targets[rustTarget])
  throw new Error("Unsupported Code Mode build target: " + rustTarget);
mkdirSync(root + "apps/desktop/src-tauri/binaries", { recursive: true });
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "bun",
    "build",
    "--compile",
    "--minify",
    "--target=" + targets[rustTarget],
    fileURLToPath(new URL("worker.mjs", import.meta.url)),
    "--outfile=" +
      root +
      "apps/desktop/src-tauri/binaries/gyro-codemode-" +
      rustTarget,
  ],
  { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
