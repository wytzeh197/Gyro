#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(repoRoot, "apps/desktop/src-tauri/tauri.conf.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

const pubkey = config.plugins?.updater?.pubkey;
const failures = [];

if (!pubkey) {
  failures.push("plugins.updater.pubkey is missing.");
}

if (pubkey === "GYRO_DEV_UPDATER_PUBKEY_REPLACE_BEFORE_RELEASE") {
  failures.push(
    "plugins.updater.pubkey is still the development placeholder. Generate a real Tauri updater key before release.",
  );
}

if (config.bundle?.createUpdaterArtifacts !== true) {
  failures.push(
    "bundle.createUpdaterArtifacts must be true for direct app updates.",
  );
}

if (failures.length > 0) {
  console.error("Gyro release configuration is not ready.\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error(
    "\nGenerate keys with `pnpm --filter @gyro-dev/desktop tauri signer generate` and store the private key in CI secrets.",
  );
  process.exit(1);
}

console.log("Gyro release configuration looks ready.");
