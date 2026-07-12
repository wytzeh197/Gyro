#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.GYRO_TAURI_CONFIG_PATH
  ? resolve(process.env.GYRO_TAURI_CONFIG_PATH)
  : resolve(repoRoot, "apps/desktop/src-tauri/tauri.conf.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const rootPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);
const desktopPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "apps/desktop/package.json"), "utf8"),
);
const uiPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/ui/package.json"), "utf8"),
);
const cargoManifest = readFileSync(resolve(repoRoot, "Cargo.toml"), "utf8");
const releaseWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/release.yml"),
  "utf8",
);

const pubkey = config.plugins?.updater?.pubkey;
const failures = [];
const githubLatestEndpoint =
  "https://github.com/wytzeh197/Gyro/releases/latest/download/latest.json";

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

if (
  config.plugins?.updater?.endpoints?.length !== 1 ||
  config.plugins.updater.endpoints[0] !== githubLatestEndpoint
) {
  failures.push(
    `plugins.updater.endpoints must contain only ${githubLatestEndpoint}.`,
  );
}

const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = new Map([
  ["root package", rootPackage.version],
  ["desktop package", desktopPackage.version],
  ["UI package", uiPackage.version],
  ["Cargo workspace", cargoVersion],
  ["Tauri config", config.version],
]);
const expectedVersion = rootPackage.version;
for (const [label, version] of versions) {
  if (version !== expectedVersion) {
    failures.push(
      `${label} version ${version ?? "missing"} does not match ${expectedVersion}.`,
    );
  }
}

const tag = process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag.slice(1) !== expectedVersion) {
  failures.push(`Git tag ${tag} does not match version ${expectedVersion}.`);
}

for (const marker of [
  "needs: macos",
  "actions/upload-artifact@v4",
  "actions/download-artifact@v4",
  "merge-multiple: true",
  "scripts/create-updater-manifest.mjs",
  'gh release create "$GITHUB_REF_NAME"',
  "cp target/${{ matrix.target }}/release/bundle/dmg/*.dmg",
  "cp target/${{ matrix.target }}/release/bundle/macos/*.app.tar.gz",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
]) {
  if (!releaseWorkflow.includes(marker)) {
    failures.push(`Release workflow is missing ${marker}.`);
  }
}

for (const unsafeMarker of ["tauri-apps/tauri-action", "includeUpdaterJson"]) {
  if (releaseWorkflow.includes(unsafeMarker)) {
    failures.push(
      `Release workflow must not use ${unsafeMarker}; parallel publishers can split a multi-architecture release.`,
    );
  }
}

if (process.env.CI) {
  for (const variable of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]) {
    if (!process.env[variable]?.trim()) {
      failures.push(`${variable} is missing from the release environment.`);
    }
  }
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
