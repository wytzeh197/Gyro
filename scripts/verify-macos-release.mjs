#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const usage = `Usage:
  node scripts/verify-macos-release.mjs --app <Gyro.app> --dmg <Gyro.dmg> [--dmg <Gyro.dmg>]

Verifies Developer ID signing, hardened runtime, Gatekeeper acceptance, and
stapled notarization tickets before macOS release artifacts are uploaded.`;

function parseArgs(argv) {
  let app;
  const dmgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(usage);
      process.exit(0);
    }

    if (argument !== "--app" && argument !== "--dmg") {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a path.`);
    }
    index += 1;

    if (argument === "--app") {
      if (app) {
        throw new Error("--app may only be provided once.");
      }
      app = resolve(value);
    } else {
      dmgs.push(resolve(value));
    }
  }

  if (!app) {
    throw new Error("--app is required.");
  }
  if (dmgs.length === 0) {
    throw new Error("At least one --dmg is required.");
  }

  return { app, dmgs };
}

function requirePath(path, kind) {
  if (!existsSync(path)) {
    throw new Error(`${kind} does not exist: ${path}`);
  }
  const stats = statSync(path);
  if (kind === "App bundle" && !stats.isDirectory()) {
    throw new Error(`${kind} must be a directory: ${path}`);
  }
  if (kind === "DMG" && !stats.isFile()) {
    throw new Error(`${kind} must be a file: ${path}`);
  }
}

function run(command, args, capture = false) {
  console.log(`+ ${command} ${args.map(quoteArgument).join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(`${command} exited with status ${result.status}.`);
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (capture && output) {
    process.stdout.write(output);
  }
  return output;
}

function quoteArgument(argument) {
  return /^[A-Za-z0-9_./:=+-]+$/.test(argument)
    ? argument
    : JSON.stringify(argument);
}

function verifyDeveloperId(path, label, requireRuntime) {
  const details = run("codesign", ["--display", "--verbose=4", path], true);
  if (!details.includes("Authority=Developer ID Application:")) {
    throw new Error(
      `${label} is not signed with a Developer ID Application identity.`,
    );
  }
  if (details.includes("Signature=adhoc")) {
    throw new Error(`${label} is only ad-hoc signed.`);
  }
  if (/^TeamIdentifier=(?:not set)?\s*$/m.test(details)) {
    throw new Error(`${label} does not have an Apple Team identifier.`);
  }
  if (requireRuntime && !/flags=.*\bruntime\b/.test(details)) {
    throw new Error(`${label} does not enable the hardened runtime.`);
  }
}

function verifyApp(app) {
  requirePath(app, "App bundle");
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", app]);
  verifyDeveloperId(app, "App bundle", true);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  run("xcrun", ["stapler", "validate", app]);
}

function verifyDmg(dmg) {
  requirePath(dmg, "DMG");
  run("codesign", ["--verify", "--strict", "--verbose=4", dmg]);
  verifyDeveloperId(dmg, "DMG", false);
  run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmg,
  ]);
  run("xcrun", ["stapler", "validate", dmg]);
}

try {
  const { app, dmgs } = parseArgs(process.argv.slice(2));
  verifyApp(app);
  for (const dmg of dmgs) {
    verifyDmg(dmg);
  }
  console.log(`Verified ${app} and ${dmgs.length} notarized DMG artifact(s).`);
} catch (error) {
  console.error(`macOS release verification failed: ${error.message}`);
  console.error(usage);
  process.exit(1);
}
