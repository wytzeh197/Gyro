#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceApp = resolve(repoRoot, "target/release/bundle/macos/Gyro.app");
const applicationsDir = resolve(homedir(), "Applications");
const destinationApp = resolve(applicationsDir, "Gyro.app");
const destinationExecutable = resolve(
  destinationApp,
  "Contents/MacOS/gyro-desktop",
);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function isInstalledAppRunning() {
  return (
    spawnSync("pgrep", ["-f", destinationExecutable], {
      stdio: "ignore",
    }).status === 0
  );
}

function waitForInstalledAppState(running, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isInstalledAppRunning() === running) {
      return true;
    }
    Atomics.wait(waitBuffer, 0, 0, 100);
  }
  return isInstalledAppRunning() === running;
}

if (!existsSync(sourceApp)) {
  console.error(
    "Gyro.app was not found. Run `pnpm desktop:bundle` before installing locally.",
  );
  process.exit(1);
}

if (isInstalledAppRunning()) {
  spawnSync(
    "osascript",
    ["-e", 'tell application id "dev.gyro.desktop" to quit'],
    { stdio: "ignore" },
  );
  if (!waitForInstalledAppState(false)) {
    console.error(
      "The running Gyro app did not quit; the existing installation was left untouched.",
    );
    process.exit(1);
  }
}

mkdirSync(applicationsDir, { recursive: true });
rmSync(destinationApp, { recursive: true, force: true });
cpSync(sourceApp, destinationApp, { recursive: true });

if (process.env.GYRO_SKIP_LOCAL_CODESIGN !== "1") {
  const sign = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", destinationApp],
    { stdio: "inherit" },
  );

  if (sign.status !== 0) {
    console.warn(
      "Ad-hoc signing failed; continuing with the copied local app bundle.",
    );
  }
}

const open = spawnSync("open", [destinationApp], { stdio: "inherit" });
if (open.status !== 0) {
  process.exit(open.status ?? 1);
}

if (!waitForInstalledAppState(true)) {
  console.error(
    "Gyro.app was installed, but the new application process did not start.",
  );
  process.exit(1);
}

console.log(`Installed and opened ${destinationApp}`);
