#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supportedTargets = new Map([
  ["aarch64-apple-darwin", "arm64"],
  ["x86_64-apple-darwin", "x86_64"],
]);
const signingModes = new Set(["adhoc", "developer-id"]);

function argument(name) {
  const indexes = process.argv.flatMap((value, index) =>
    value === name ? [index] : [],
  );
  if (indexes.length > 1) throw new Error(`${name} may only be provided once`);
  if (indexes.length === 0) return undefined;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new Error(`${command} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}${
        output ? `:\n${output}` : ""
      }`,
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function plistValue(plistPath, key) {
  return run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    plistPath,
  ]).stdout.trim();
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
    );
  }
}

function requireFile(path, label) {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`${label} is missing at ${path}`);
  }
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function verifyChecksum(dmgPath, checksumsPath) {
  if (!checksumsPath) {
    console.log("SHA256SUMS not present; checksum verification skipped.");
    return;
  }

  const entries = new Map();
  for (const [index, line] of readFileSync(checksumsPath, "utf8")
    .split(/\r?\n/)
    .entries()) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-fA-F0-9]{64}) ([ *])(.+)$/);
    if (!match) {
      throw new Error(
        `${checksumsPath}:${index + 1} is not a valid SHA-256 checksum line`,
      );
    }
    if (entries.has(match[3])) {
      throw new Error(`${checksumsPath} contains duplicate entry ${match[3]}`);
    }
    entries.set(match[3], match[1].toLowerCase());
  }

  const dmgName = basename(dmgPath);
  const expected = entries.get(dmgName);
  if (!expected) {
    throw new Error(`${checksumsPath} does not contain ${dmgName}`);
  }
  const actual = await sha256(dmgPath);
  requireEqual(actual, expected, `SHA-256 for ${dmgName}`);
  console.log(`Verified SHA-256 from ${basename(checksumsPath)}.`);
}

function verifyApplicationsShortcut(mountPath) {
  const shortcutPath = join(mountPath, "Applications");
  if (!lstatExists(shortcutPath)) {
    throw new Error("DMG is missing its Applications shortcut");
  }
  if (!lstatSync(shortcutPath).isSymbolicLink()) {
    throw new Error("DMG Applications shortcut must be a symbolic link");
  }
  requireEqual(
    readlinkSync(shortcutPath),
    "/Applications",
    "DMG Applications shortcut target",
  );
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function verifyBundle(appPath, config, target, signing) {
  const infoPlistPath = join(appPath, "Contents", "Info.plist");
  requireFile(infoPlistPath, "app Info.plist");

  const expectedIcon = config.bundle.icon
    .map((path) => basename(path))
    .find((name) => name.endsWith(".icns"));
  if (!expectedIcon) throw new Error("Tauri bundle config has no .icns icon");

  requireEqual(
    plistValue(infoPlistPath, "CFBundleIdentifier"),
    config.identifier,
    "CFBundleIdentifier",
  );
  requireEqual(
    plistValue(infoPlistPath, "CFBundleShortVersionString"),
    config.version,
    "CFBundleShortVersionString",
  );
  requireEqual(
    plistValue(infoPlistPath, "CFBundleVersion"),
    config.version,
    "CFBundleVersion",
  );
  requireEqual(
    plistValue(infoPlistPath, "CFBundleDisplayName"),
    config.productName,
    "CFBundleDisplayName",
  );
  requireEqual(
    plistValue(infoPlistPath, "CFBundleName"),
    config.productName,
    "CFBundleName",
  );
  requireEqual(
    plistValue(infoPlistPath, "CFBundlePackageType"),
    "APPL",
    "CFBundlePackageType",
  );
  requireEqual(
    plistValue(infoPlistPath, "LSMinimumSystemVersion"),
    config.bundle.macOS.minimumSystemVersion,
    "LSMinimumSystemVersion",
  );

  const bundleIcon = plistValue(infoPlistPath, "CFBundleIconFile");
  requireEqual(bundleIcon, expectedIcon, "CFBundleIconFile");
  requireFile(
    join(appPath, "Contents", "Resources", bundleIcon),
    "bundle icon",
  );

  const executableName = plistValue(infoPlistPath, "CFBundleExecutable");
  if (basename(executableName) !== executableName) {
    throw new Error(
      `CFBundleExecutable contains an invalid path: ${executableName}`,
    );
  }
  const executablePath = join(appPath, "Contents", "MacOS", executableName);
  requireFile(executablePath, "bundle executable");
  accessSync(executablePath, constants.X_OK);

  const expectedArch = supportedTargets.get(target);
  const architectures = run("lipo", ["-archs", executablePath])
    .stdout.trim()
    .split(/\s+/)
    .filter(Boolean);
  requireEqual(
    architectures.join(" "),
    expectedArch,
    "bundle executable architecture",
  );

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  const signature = run("codesign", ["--display", "--verbose=4", appPath]);
  const signatureDetails = `${signature.stdout}\n${signature.stderr}`;
  if (!signatureDetails.includes(`Identifier=${config.identifier}`)) {
    throw new Error(`bundle signature is missing Identifier=${config.identifier}`);
  }
  if (signing.mode === "developer-id") {
    verifyDeveloperIdBundle(appPath, signatureDetails, signing);
  } else {
    verifyAdhocBundle(signatureDetails);
  }
}

function requireMarkers(details, label, required, forbidden) {
  for (const marker of required) {
    if (!details.includes(marker)) {
      throw new Error(`${label} signature is missing ${marker}`);
    }
  }
  for (const marker of forbidden) {
    if (details.includes(marker)) {
      throw new Error(`${label} signature unexpectedly contains ${marker}`);
    }
  }
}

// Alpha builds carry a complete ad-hoc signature and nothing that could be
// mistaken for an Apple-issued identity.
function verifyAdhocBundle(signatureDetails) {
  requireMarkers(
    signatureDetails,
    "bundle",
    ["Signature=adhoc", "TeamIdentifier=not set", "Sealed Resources version="],
    ["Authority=", "Developer ID", "linker-signed", "Sealed Resources=none"],
  );
}

// Release builds must be signed by Gyro's Developer ID with a secure
// timestamp and the hardened runtime, carry a stapled notarization ticket,
// and pass Gatekeeper exactly as a freshly downloaded copy would.
function verifyDeveloperIdBundle(appPath, signatureDetails, signing) {
  requireMarkers(
    signatureDetails,
    "bundle",
    [
      "Authority=Developer ID Application: ",
      "Authority=Developer ID Certification Authority",
      "Authority=Apple Root CA",
      `TeamIdentifier=${signing.teamId}`,
      "Timestamp=",
      "Sealed Resources version=",
    ],
    ["Signature=adhoc", "linker-signed", "Sealed Resources=none"],
  );
  if (!/flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/.test(signatureDetails)) {
    throw new Error("bundle signature does not enable the hardened runtime");
  }
  const entitlements = run("codesign", [
    "--display",
    "--entitlements",
    "-",
    "--xml",
    appPath,
  ]);
  if (
    `${entitlements.stdout}\n${entitlements.stderr}`.includes(
      "com.apple.security.get-task-allow",
    )
  ) {
    throw new Error("bundle is signed with the debugging get-task-allow entitlement");
  }
  run("xcrun", ["stapler", "validate", appPath]);
  const assessment = run("spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    appPath,
  ]);
  requireGatekeeperSource(assessment, "app bundle");
}

function requireGatekeeperSource(assessment, label) {
  const details = `${assessment.stdout}\n${assessment.stderr}`;
  if (!details.includes("source=Notarized Developer ID")) {
    throw new Error(
      `Gatekeeper did not accept the ${label} as notarized Developer ID software:\n${details.trim()}`,
    );
  }
}

function verifyDeveloperIdDmg(dmgPath, signing) {
  run("codesign", ["--verify", "--strict", "--verbose=4", dmgPath]);
  const signature = run("codesign", ["--display", "--verbose=4", dmgPath]);
  requireMarkers(
    `${signature.stdout}\n${signature.stderr}`,
    "DMG",
    [
      "Authority=Developer ID Application: ",
      `TeamIdentifier=${signing.teamId}`,
      "Timestamp=",
    ],
    ["Signature=adhoc"],
  );
  run("xcrun", ["stapler", "validate", dmgPath]);
  const assessment = run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmgPath,
  ]);
  requireGatekeeperSource(assessment, "DMG");
}

// The updater installs the app from this archive, so it must hold the same
// signed (and, for Developer ID builds, stapled) bundle as the DMG.
function verifyUpdaterArchive(archivePath, config, target, signing) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "gyro-release-updater-"));
  try {
    run("tar", ["-xzf", archivePath, "-C", temporaryRoot]);
    const appName = `${config.productName}.app`;
    requireEqual(
      readdirSync(temporaryRoot).join(" "),
      appName,
      "updater archive contents",
    );
    verifyBundle(join(temporaryRoot, appName), config, target, signing);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function attachAndVerifyDmg(dmgPath, config, target, signing) {
  run("hdiutil", ["verify", dmgPath]);
  if (signing.mode === "developer-id") verifyDeveloperIdDmg(dmgPath, signing);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "gyro-release-dmg-"));
  const mountPath = join(temporaryRoot, "mounted");
  mkdirSync(mountPath);
  let attached = false;
  let failure;
  try {
    run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPath,
      dmgPath,
    ]);
    attached = true;

    verifyApplicationsShortcut(mountPath);
    const appName = `${config.productName}.app`;
    const appEntries = readdirSync(mountPath).filter((name) =>
      name.endsWith(".app"),
    );
    requireEqual(appEntries.join(" "), appName, "DMG app bundle");
    const appPath = join(mountPath, appName);
    if (!lstatSync(appPath).isDirectory()) {
      throw new Error(`${appName} is not an app bundle directory`);
    }
    verifyBundle(appPath, config, target, signing);
  } catch (error) {
    failure = error;
  } finally {
    if (attached) {
      const detach = spawnSync("hdiutil", ["detach", mountPath], {
        encoding: "utf8",
      });
      if (detach.error || detach.status !== 0) {
        const details = `${detach.stdout ?? ""}\n${detach.stderr ?? ""}`.trim();
        const detachError = new Error(
          `hdiutil could not detach ${mountPath}${details ? `:\n${details}` : ""}`,
        );
        failure ??= detachError;
      }
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Verify a Gyro macOS release DMG:
  node scripts/verify-macos-release.mjs --dmg <path> --target <target>
    [--checksums <SHA256SUMS>] [--updater-archive <Gyro.app.tar.gz>]
    [--signing adhoc|developer-id] [--team-id <TEAMID>]

Supported targets: ${[...supportedTargets.keys()].join(", ")}
--signing defaults to adhoc. developer-id requires --team-id and checks the
Developer ID signature, hardened runtime, timestamp, stapled notarization
tickets, and Gatekeeper acceptance of both the app and the DMG.`);
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("macOS release verification must run on macOS");
  }

  const dmgArgument = argument("--dmg");
  const target = argument("--target");
  const checksumsArgument = argument("--checksums");
  const updaterArchiveArgument = argument("--updater-archive");
  const signing = {
    mode: argument("--signing") ?? "adhoc",
    teamId: argument("--team-id"),
  };
  if (!dmgArgument || !target) {
    throw new Error(
      "use --dmg <path> --target <target> [--checksums <SHA256SUMS>]",
    );
  }
  if (!supportedTargets.has(target)) {
    throw new Error(`unsupported release target ${target}`);
  }
  if (!signingModes.has(signing.mode)) {
    throw new Error(`unsupported signing mode ${signing.mode}`);
  }
  if (signing.mode === "developer-id" && !/^[A-Z0-9]{10}$/.test(signing.teamId ?? "")) {
    throw new Error("--signing developer-id requires a 10-character --team-id");
  }
  if (signing.mode === "adhoc" && signing.teamId) {
    throw new Error("--team-id only applies to --signing developer-id");
  }

  const dmgPath = resolve(dmgArgument);
  requireFile(dmgPath, "release DMG");
  const config = JSON.parse(
    readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf8",
    ),
  );
  const adjacentChecksums = resolve(dirname(dmgPath), "SHA256SUMS");
  const checksumsPath = checksumsArgument
    ? resolve(checksumsArgument)
    : existsSync(adjacentChecksums)
      ? adjacentChecksums
      : undefined;
  if (checksumsArgument) requireFile(checksumsPath, "SHA256SUMS");

  await verifyChecksum(dmgPath, checksumsPath);
  attachAndVerifyDmg(dmgPath, config, target, signing);
  if (updaterArchiveArgument) {
    const archivePath = resolve(updaterArchiveArgument);
    requireFile(archivePath, "updater archive");
    verifyUpdaterArchive(archivePath, config, target, signing);
    console.log(`Verified ${basename(archivePath)} holds the same signed app.`);
  }
  console.log(
    `Verified ${basename(dmgPath)} as the ${target} Gyro ${config.version} release DMG (${signing.mode} signing).`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`macOS release verification failed: ${error.message}`);
  process.exitCode = 1;
}
