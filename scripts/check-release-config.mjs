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
const ciWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const cliPackager = readFileSync(
  resolve(repoRoot, "scripts/package-cli-release.mjs"),
  "utf8",
);
const cliFinalizer = readFileSync(
  resolve(repoRoot, "scripts/finalize-cli-release.mjs"),
  "utf8",
);
const macosReleaseVerifier = readFileSync(
  resolve(repoRoot, "scripts/verify-macos-release.mjs"),
  "utf8",
);
const homebrewFormula = readFileSync(
  resolve(repoRoot, "packaging/homebrew/Formula/gyro.rb"),
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
const expectedTauriCliVersion = "2.11.4";
for (const [label, version] of versions) {
  if (version !== expectedVersion) {
    failures.push(
      `${label} version ${version ?? "missing"} does not match ${expectedVersion}.`,
    );
  }
}

if (
  desktopPackage.devDependencies?.["@tauri-apps/cli"] !==
  expectedTauriCliVersion
) {
  failures.push(
    `Desktop @tauri-apps/cli must be pinned to ${expectedTauriCliVersion} for the audited macOS certificate-import path.`,
  );
}

const tag = process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag.slice(1) !== expectedVersion) {
  failures.push(`Git tag ${tag} does not match version ${expectedVersion}.`);
}

for (const marker of [
  "needs: macos",
  "Verify pinned Tauri release toolchain",
  'tauri --version)" = "tauri-cli 2.11.4"',
  "group: release-${{ github.ref }}",
  "cancel-in-progress: false",
  "actions/upload-artifact@v4",
  "actions/download-artifact@v4",
  "merge-multiple: true",
  "scripts/create-updater-manifest.mjs",
  'gh release create "$GITHUB_REF_NAME"',
  "cp target/${{ matrix.target }}/release/bundle/dmg/*.dmg",
  "release-assets/Gyro_${{ matrix.updater_suffix }}.app.tar.gz",
  "updater_suffix: aarch64",
  "updater_suffix: x64",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "runner: macos-15",
  "runner: macos-15-intel",
  "cargo build --release -p gyro-cli --target ${{ matrix.target }}",
  "scripts/package-cli-release.mjs",
  "gyro-cli-${VERSION}-${{ matrix.target }}.tar.gz",
  "scripts/finalize-cli-release.mjs",
  "APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}",
  "APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}",
  "APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}",
  "APPLE_ID: ${{ secrets.APPLE_ID }}",
  "APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}",
  "APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}",
  "Developer ID signed, notarized, and updater-signed",
  "Notarize and staple signed DMGs",
  'xcrun notarytool submit "$dmg"',
  'test "$(jq -r \'.status\' "$RESULT")" = "Accepted"',
  'xcrun stapler staple -v "$dmg"',
  "Verify Apple signature, Gatekeeper, and notarization tickets",
  "scripts/verify-macos-release.mjs",
  'VERIFY_ARGS=(--app "$APP")',
  'VERIFY_ARGS+=(--dmg "$dmg")',
  "--json isDraft --jq '.isDraft'",
  'if [ "$IS_DRAFT" != "true" ]',
  "Refusing to overwrite published release",
  'gh release edit "$GITHUB_REF_NAME"',
  '--notes "$RELEASE_NOTES"',
]) {
  if (!releaseWorkflow.includes(marker)) {
    failures.push(`Release workflow is missing ${marker}.`);
  }
}

const draftGuardIndex = releaseWorkflow.indexOf("--json isDraft");
const releaseUploadIndex = releaseWorkflow.indexOf("gh release upload");
if (
  draftGuardIndex === -1 ||
  releaseUploadIndex === -1 ||
  draftGuardIndex > releaseUploadIndex
) {
  failures.push(
    "Release workflow must verify an existing release is still a draft before uploading assets.",
  );
}

for (const marker of [
  'run("codesign", ["--verify", "--deep", "--strict"',
  'details.includes("Authority=Developer ID Application:")',
  'details.includes("Signature=adhoc")',
  "TeamIdentifier=",
  "hardened runtime",
  'run("spctl", ["--assess", "--type", "execute"',
  'run("xcrun", ["stapler", "validate", app])',
  'run("xcrun", ["stapler", "validate", dmg])',
]) {
  if (!macosReleaseVerifier.includes(marker)) {
    failures.push(`macOS release verifier is missing ${marker}.`);
  }
}

for (const marker of [
  "APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}",
  "APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}",
  "APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}",
  "APPLE_ID: ${{ secrets.APPLE_ID }}",
  "APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}",
  "APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}",
]) {
  const occurrences = releaseWorkflow.split(marker).length - 1;
  if (occurrences < 2) {
    failures.push(
      `Release workflow must pass ${marker.split(":", 1)[0]} to both preflight and the Tauri build.`,
    );
  }
}

for (const marker of [
  "cargo build -p gyro-cli",
  "scripts/check-cli-release-packaging.mjs",
]) {
  if (!ciWorkflow.includes(marker)) {
    failures.push(`CI workflow is missing ${marker}.`);
  }
}

for (const marker of [
  "gyro.cli.archive.v1",
  "manifest.json",
  "--verify",
  "--run",
  "doctor",
  "completions",
]) {
  if (!cliPackager.includes(marker)) {
    failures.push(`CLI release packager is missing ${marker}.`);
  }
}

for (const marker of [
  "SHA256SUMS",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "gyro.rb",
  "generate_completions_from_executable",
]) {
  if (!cliFinalizer.includes(marker)) {
    failures.push(`CLI release finalizer is missing ${marker}.`);
  }
}

for (const marker of [
  `version "${expectedVersion}"`,
  "releases/download/v#{version}/gyro-cli-#{version}-aarch64-apple-darwin.tar.gz",
  "releases/download/v#{version}/gyro-cli-#{version}-x86_64-apple-darwin.tar.gz",
  "REPLACE_WITH_AARCH64_CLI_SHA256",
  "REPLACE_WITH_X86_64_CLI_SHA256",
  "generate_completions_from_executable",
]) {
  if (!homebrewFormula.includes(marker)) {
    failures.push(`Homebrew Formula template is missing ${marker}.`);
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
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
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
    "\nConfigure both the Tauri updater key and Apple Developer ID/notarization credentials in GitHub Actions before tagging a release.",
  );
  process.exit(1);
}

console.log("Gyro release configuration looks ready.");
