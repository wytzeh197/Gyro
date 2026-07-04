#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.cwd();
const failures = [];

if (cwd !== repoRoot) {
  failures.push(`Run this from the repository root:\n  cd "${repoRoot}"`);
}

for (const file of [
  "Cargo.toml",
  "pnpm-workspace.yaml",
  "apps/desktop/package.json",
]) {
  if (!existsSync(resolve(repoRoot, file))) {
    failures.push(`Missing ${file}; expected Gyro repo root at ${repoRoot}`);
  }
}

const requiredCommands = [
  ["node", ["--version"], "Install Node.js 22 or newer."],
  ["pnpm", ["--version"], "Install pnpm 11 or newer."],
  [
    "cargo",
    ["--version"],
    "Install Rust with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
  ],
];

for (const [command, args, installHint] of requiredCommands) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    failures.push(`${command} is not available. ${installHint}`);
  }
}

if (process.platform === "darwin") {
  const result = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    failures.push(
      "Xcode command line tools are missing. Install with: xcode-select --install",
    );
  }
}

if (failures.length > 0) {
  console.error("Gyro development environment is not ready.\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error("\nAfter fixing the above, run: pnpm desktop:dev");
  process.exit(1);
}

console.log("Gyro development environment looks ready.");
