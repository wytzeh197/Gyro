#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
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

// A Developer ID bundle is already sealed and notarized; re-signing it ad-hoc
// would discard that identity and its stapled ticket.
function hasValidDeveloperIdSignature(appPath) {
  const verify = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", appPath],
    { stdio: "ignore" },
  );
  if (verify.status !== 0) return false;
  const display = spawnSync("codesign", ["--display", "--verbose=2", appPath], {
    encoding: "utf8",
  });
  return `${display.stdout ?? ""}${display.stderr ?? ""}`.includes(
    "Authority=Developer ID Application: ",
  );
}

/** Whether the copied bundle's code signature carries one entitlement key. */
function embeddedEntitlement(appPath, key) {
  const display = spawnSync(
    "codesign",
    ["--display", "--entitlements", ":-", appPath],
    { encoding: "utf8" },
  );
  return `${display.stdout ?? ""}${display.stderr ?? ""}`.includes(key);
}

/**
 * Pick a stable code-signing identity.
 *
 * macOS guards every saved API key with an access list naming the exact
 * certificate and bundle identifier that wrote it, so an ad-hoc signature —
 * a brand-new identity on every single build — can never match, and macOS asks
 * for the login password again. Any real identity already on this machine is
 * stable across rebuilds, so "Always Allow" sticks for good. Prefer a
 * Developer ID that is already installed for releases, then a locally created
 * dev identity, and only then ad-hoc.
 */
function resolveSigningIdentity() {
  const explicit = process.env.GYRO_CODESIGN_IDENTITY;
  if (explicit) return explicit;

  const listed = spawnSync(
    "security",
    ["find-identity", "-p", "codesigning"],
    { encoding: "utf8" },
  );
  const names = `${listed.stdout ?? ""}`
    .split("\n")
    .map((line) => line.match(/"([^"]+)"/)?.[1])
    .filter(Boolean);

  return (
    names.find((name) => name.startsWith("Developer ID Application: ")) ??
    names.find((name) => name === "Gyro Dev") ??
    null
  );
}

if (hasValidDeveloperIdSignature(destinationApp)) {
  console.log("Keeping the existing Developer ID signature.");
} else if (process.env.GYRO_SKIP_LOCAL_CODESIGN !== "1") {
  // Match release builds, which always run with the hardened runtime. The
  // hardened runtime gates audio input on the audio-input entitlement, so a
  // signature without Entitlements.plist is denied the microphone before TCC
  // can even show its sheet.
  const entitlements = resolve(
    repoRoot,
    "apps/desktop/src-tauri/Entitlements.plist",
  );
  const signs = (signer) =>
    spawnSync(
      "codesign",
      [
        "--force",
        "--deep",
        "--options",
        "runtime",
        "--entitlements",
        entitlements,
        "--sign",
        signer,
        destinationApp,
      ],
      { stdio: "inherit" },
    );

  const identity = resolveSigningIdentity();
  let sign = identity ? signs(identity) : null;
  if (sign && sign.status !== 0) {
    console.warn(
      `Signing with "${identity}" failed; falling back to an ad-hoc signature.`,
    );
    sign = null;
  }
  if (!sign) {
    if (!identity) {
      console.log(
        "No signing identity found, so this build is ad-hoc signed: macOS will ask for the login Keychain again after the next rebuild. Run scripts/setup-dev-signing.sh once to stop that.",
      );
    }
    sign = signs("-");
  }

  if (sign.status !== 0) {
    console.warn(
      "Ad-hoc signing failed; continuing with the copied local app bundle.",
    );
  } else if (!embeddedEntitlement(destinationApp, "com.apple.security.device.audio-input")) {
    console.error(
      "The ad-hoc signature is missing com.apple.security.device.audio-input, so the hardened runtime blocks the microphone and macOS never shows a permission sheet.",
    );
    process.exit(1);
  }
}

// Re-register the replaced bundle so Finder and Dock refresh its icon.
// Touch only the bundle directory; signed resources remain unchanged.
const installedAt = new Date();
utimesSync(destinationApp, installedAt, installedAt);
const launchServices =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const registration = spawnSync(launchServices, ["-f", destinationApp], {
  stdio: "inherit",
});
if (registration.status !== 0) {
  console.warn("macOS app registration could not be refreshed.");
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
