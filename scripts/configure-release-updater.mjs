#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.GYRO_TAURI_CONFIG_PATH
  ? resolve(process.env.GYRO_TAURI_CONFIG_PATH)
  : resolve(repoRoot, "apps/desktop/src-tauri/tauri.conf.json");
const publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();

if (!publicKey) {
  console.error(
    "TAURI_UPDATER_PUBLIC_KEY is required. Store the public key as a GitHub Actions repository variable.",
  );
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
config.plugins ??= {};
config.plugins.updater ??= {};
config.plugins.updater.pubkey = publicKey;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log("Configured the release updater public key.");
