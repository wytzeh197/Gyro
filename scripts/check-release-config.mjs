#!/usr/bin/env node

import { releaseIdentity } from "./release-identity.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const cargoLock = readFileSync(resolve(repoRoot, "Cargo.lock"), "utf8");
const releaseWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/release.yml"),
  "utf8",
);
const ciWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const homebrewWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/publish-homebrew.yml"),
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
const updaterManifest = readFileSync(
  resolve(repoRoot, "scripts/create-updater-manifest.mjs"),
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

// The DMG is the first thing a new user meets, and Tauri does not fail when
// bundle.macOS.dmg is missing or its background is off-size: Finder simply
// falls back to an auto-arranged, unstyled window. Catch that here, where it
// costs seconds instead of a release.
{
  const dmg = config.bundle?.macOS?.dmg;
  const backgroundPath = dmg?.background
    ? resolve(dirname(configPath), dmg.background)
    : undefined;
  if (!dmg) {
    failures.push(
      "bundle.macOS.dmg is missing, so the DMG ships Finder's unstyled icon layout.",
    );
  } else if (!backgroundPath) {
    failures.push("bundle.macOS.dmg.background is missing.");
  } else if (!existsSync(backgroundPath)) {
    failures.push(
      `bundle.macOS.dmg.background points at ${dmg.background}, which does not exist. Run: swift scripts/render-dmg-background.swift`,
    );
  } else {
    const header = readFileSync(backgroundPath).subarray(0, 24);
    const isPng =
      header.length === 24 &&
      header.readUInt32BE(0) === 0x89504e47 &&
      header.readUInt32BE(4) === 0x0d0a1a0a;
    const width = isPng ? header.readUInt32BE(16) : 0;
    const height = isPng ? header.readUInt32BE(20) : 0;
    const windowWidth = dmg.windowSize?.width;
    const windowHeight = dmg.windowSize?.height;
    if (!isPng) {
      failures.push(
        "bundle.macOS.dmg.background must be a PNG; the DMG bundler cannot place an SVG.",
      );
    } else if (width !== windowWidth * 2 || height !== windowHeight * 2) {
      failures.push(
        `bundle.macOS.dmg.background is ${width}×${height}, but a ${windowWidth}×${windowHeight} pt window needs ${windowWidth * 2}×${windowHeight * 2} at 2x. Run: swift scripts/render-dmg-background.swift`,
      );
    }
    for (const key of ["appPosition", "applicationFolderPosition"]) {
      const point = dmg[key];
      if (
        !point ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x <= 0 ||
        point.x >= windowWidth ||
        point.y <= 0 ||
        point.y >= windowHeight
      ) {
        failures.push(
          `bundle.macOS.dmg.${key} is missing or outside the ${windowWidth}×${windowHeight} window; Finder would auto-arrange the icons.`,
        );
      }
    }
  }
}

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

// The checked-in identity stays ad-hoc so local and alpha builds never need
// Apple credentials; the release workflow exports APPLE_SIGNING_IDENTITY to
// switch a build to Developer ID signing and notarization.
if (config.bundle?.macOS?.signingIdentity !== "-") {
  failures.push(
    'bundle.macOS.signingIdentity must stay "-"; Developer ID builds set APPLE_SIGNING_IDENTITY in the release workflow instead.',
  );
}

if (config.bundle?.macOS?.hardenedRuntime === false) {
  failures.push(
    "bundle.macOS.hardenedRuntime must not be disabled; notarization requires the hardened runtime.",
  );
}

if (config.bundle?.macOS?.minimumSystemVersion !== "14.0") {
  failures.push(
    'bundle.macOS.minimumSystemVersion must be "14.0" for the supported macOS baseline.',
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
const isStableVersion = /^\d+\.\d+\.\d+$/.test(expectedVersion);
const signingMode =
  process.env.GYRO_MACOS_SIGNING ||
  (isStableVersion ? "developer-id" : "adhoc");
if (!["adhoc", "developer-id"].includes(signingMode)) {
  failures.push(
    `GYRO_MACOS_SIGNING must be adhoc or developer-id, not ${signingMode}.`,
  );
}
if (isStableVersion && signingMode !== "developer-id") {
  failures.push(
    `Stable release ${expectedVersion} must be Developer ID signed and notarized.`,
  );
}
const releaseNotesPath = resolve(
  repoRoot,
  `docs/releases/${releaseIdentity.tag}.md`,
);
if (!existsSync(releaseNotesPath)) {
  failures.push(
    `Versioned release notes are missing at docs/releases/v${expectedVersion}.md.`,
  );
} else {
  const releaseNotes = readFileSync(releaseNotesPath, "utf8");
  for (const marker of [
    `# Gyro v${expectedVersion}`,
    "## Download and install",
    "https://usegyro.io/",
    `Gyro_${expectedVersion}_aarch64.dmg`,
    `Gyro_${expectedVersion}_x64.dmg`,
    "SHA256SUMS",
    "docs/install-macos.md",
    "macOS 14+",
    "## Upgrade and rollback",
    "## CLI",
    signingMode === "developer-id"
      ? "notarized by Apple"
      : "not Apple-signed or notarized",
  ]) {
    if (!releaseNotes.includes(marker)) {
      failures.push(`Versioned release notes are missing ${marker}.`);
    }
  }
  if (
    signingMode === "developer-id" &&
    releaseNotes.includes("not Apple-signed or notarized")
  ) {
    failures.push(
      "Versioned release notes for a Developer ID build still say it is not Apple-signed or notarized.",
    );
  }
}
const expectedTauriCliVersion = "2.11.4";
for (const [label, version] of versions) {
  if (version !== expectedVersion) {
    failures.push(
      `${label} version ${version ?? "missing"} does not match ${expectedVersion}.`,
    );
  }
}

for (const packageName of ["gyro-cli", "gyro-core", "gyro-desktop"]) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lockedVersion = cargoLock.match(
    new RegExp(
      `\\[\\[package\\]\\]\\nname = "${escapedName}"\\nversion = "([^"]+)"`,
    ),
  )?.[1];
  if (lockedVersion !== expectedVersion) {
    failures.push(
      `Cargo.lock ${packageName} version ${lockedVersion ?? "missing"} does not match ${expectedVersion}.`,
    );
  }
}

if (
  desktopPackage.devDependencies?.["@tauri-apps/cli"] !==
  expectedTauriCliVersion
) {
  failures.push(
    `Desktop @tauri-apps/cli must be pinned to ${expectedTauriCliVersion} for reproducible GitHub release builds.`,
  );
}

const tag = process.env.GITHUB_REF_NAME;
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  tag?.startsWith("v") &&
  tag !== releaseIdentity.tag
) {
  failures.push(`Git tag ${tag} does not match version ${expectedVersion}.`);
}

for (const marker of [
  "workflow_dispatch:",
  "Validate release request",
  "Verify immutable merged release source",
  'test "$COMMIT" = "$EXPECTED_COMMIT"',
  'git merge-base --is-ancestor "$COMMIT" origin/main',
  "requireReleaseTag(process.env.RELEASE_TAG)",
  "ref: ${{ needs.signing.outputs.commit }}",
  'GITHUB_REF_NAME="$RELEASE_TAG" pnpm release:check',
  "Use TCP for Apple notarization tickets",
  "block return out quick proto udp from any to any port 443",
  "sudo pfctl -E",
  "refusing to upload an unstapled image",
  "needs: [signing, macos]",
  "needs: signing",
  "GYRO_MACOS_SIGNING: ${{ needs.signing.outputs.mode }}",
  "Resolve Developer ID or ad-hoc signing",
  "Stable release $RELEASE_TAG must be Developer ID signed and notarized",
  "Import Developer ID certificate",
  'KEYCHAIN_PATH="$RUNNER_TEMP/gyro-signing.keychain-db"',
  "security set-key-partition-list",
  "export APPLE_SIGNING_IDENTITY=",
  "export APPLE_API_KEY_PATH=",
  "Sign and notarize macOS DMG",
  "codesign --force --timestamp",
  "xcrun notarytool submit",
  'if [ "$STATUS" != "Accepted" ]',
  "xcrun notarytool info",
  "submissions/",
  'node scripts/staple-macos-artifact.mjs "${DMGS[0]}"',
  '--signing "$GYRO_MACOS_SIGNING"',
  '--team-id "$GYRO_APPLE_TEAM_ID"',
  "--updater-archive",
  "Remove signing keychain and notary key",
  "if: always() && env.GYRO_MACOS_SIGNING == 'developer-id'",
  'security delete-keychain "$GYRO_KEYCHAIN_PATH"',
  '--signing "${{ needs.signing.outputs.mode }}"',
  "Verify pinned Tauri release toolchain",
  'tauri --version)" = "tauri-cli 2.11.4"',
  'GYRO_REQUIRE_RELEASE_SECRETS: "1"',
  "group: release-${{ inputs.release_tag || github.ref_name }}",
  "cancel-in-progress: false",
  "actions/upload-artifact@v4",
  "actions/download-artifact@v4",
  "merge-multiple: true",
  "scripts/create-updater-manifest.mjs",
  'gh release create "$RELEASE_TAG"',
  "cp target/${{ matrix.target }}/release/bundle/dmg/*.dmg",
  "release-assets/Gyro_${{ matrix.updater_suffix }}.app.tar.gz",
  "updater_suffix: aarch64",
  "updater_suffix: x64",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "runner: macos-15",
  "runner: macos-15-intel",
  "cargo build --locked --release -p gyro-cli --target ${{ matrix.target }}",
  "scripts/package-cli-release.mjs",
  "gyro-cli-${VERSION}-${{ matrix.target }}.tar.gz",
  "scripts/finalize-cli-release.mjs",
  "scripts/verify-macos-release.mjs",
  "Verify macOS DMG",
  '--target "${{ matrix.target }}"',
  '--checksums "$DMG_CHECKSUMS"',
  "sha256sum --check SHA256SUMS",
  "Build desktop app and sign updater archive",
  "--json isDraft --jq '.isDraft'",
  'if [ "$IS_DRAFT" != "true" ]',
  "Refusing to overwrite published release",
  'gh release edit "$RELEASE_TAG"',
  '--notes "$RELEASE_NOTES"',
  'NOTES_PATH="docs/releases/${RELEASE_TAG}.md"',
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
  "cargo build --locked -p gyro-cli",
  "scripts/check-cli-release-packaging.mjs",
]) {
  if (!ciWorkflow.includes(marker)) {
    failures.push(`CI workflow is missing ${marker}.`);
  }
}

for (const marker of [
  "workflow_dispatch:",
  "brew tap-new gyro/release-validation",
  'cp "$PWD/release-assets/gyro.rb" "$FORMULA_DIRECTORY/gyro.rb"',
  "brew install --formula gyro/release-validation/gyro",
  "brew test gyro/release-validation/gyro",
  "runner: macos-15",
  "runner: macos-15-intel",
  "sync-gyro-formula.yml",
]) {
  if (!homebrewWorkflow.includes(marker)) {
    failures.push(`Homebrew publish workflow is missing ${marker}.`);
  }
}

if (/secrets\.HOMEBREW_TAP_TOKEN/.test(homebrewWorkflow)) {
  failures.push(
    "Homebrew workflow pushes to the tap with a cross-repository token again; " +
      "the tap pulls the Formula itself in sync-gyro-formula.yml.",
  );
}

for (const marker of [
  'run("hdiutil", ["verify", dmgPath])',
  '"--verify", "--deep", "--strict"',
  '"Signature=adhoc"',
  '"TeamIdentifier=not set"',
  '"Sealed Resources version="',
  '"Developer ID"',
  '"Authority=Developer ID Application: "',
  "`TeamIdentifier=${signing.teamId}`",
  '"Timestamp="',
  "bundle signature does not enable the hardened runtime",
  "com.apple.security.get-task-allow",
  "validateStaple(appPath)",
  "validateStaple(dmgPath)",
  "staplerFailureIsTransient",
  '"context:primary-signature"',
  '"source=Notarized Developer ID"',
  "verifyUpdaterArchive(archivePath, config, target, signing)",
  'plistValue(infoPlistPath, "CFBundleIdentifier")',
  'plistValue(infoPlistPath, "CFBundleVersion")',
  'plistValue(infoPlistPath, "CFBundleName")',
  'plistValue(infoPlistPath, "LSMinimumSystemVersion")',
  'plistValue(infoPlistPath, "CFBundleIconFile")',
  "readlinkSync(shortcutPath)",
  '"/Applications"',
  '"SHA256SUMS"',
  "supportedTargets.get(target)",
]) {
  if (!macosReleaseVerifier.includes(marker)) {
    failures.push(`macOS release verifier is missing ${marker}.`);
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

for (const [marker, meaning] of [
  [
    "Updater archives are signed; app bundles and DMGs are not Apple-signed or notarized.",
    "the ad-hoc alpha status",
  ],
  [
    "Updater archives are signed; app bundles and DMGs are signed with Gyro's Developer ID and notarized by Apple.",
    "the Developer ID status",
  ],
  [
    "must be Developer ID signed and notarized",
    "that stable releases refuse ad-hoc signing",
  ],
]) {
  if (!updaterManifest.includes(marker)) {
    failures.push(`Updater manifest must disclose ${meaning}.`);
  }
}

for (const marker of [
  `version "${expectedVersion}"`,
  `releases/download/${releaseIdentity.tag}/gyro-cli-#{version}-aarch64-apple-darwin.tar.gz`,
  `releases/download/${releaseIdentity.tag}/gyro-cli-#{version}-x86_64-apple-darwin.tar.gz`,
  "REPLACE_WITH_AARCH64_CLI_SHA256",
  "REPLACE_WITH_X86_64_CLI_SHA256",
  "generate_completions_from_executable",
]) {
  if (!homebrewFormula.includes(marker)) {
    failures.push(`Homebrew Formula template is missing ${marker}.`);
  }
}

for (const unsafeMarker of [
  "tauri-apps/tauri-action",
  "includeUpdaterJson",
  "--no-sign",
]) {
  if (releaseWorkflow.includes(unsafeMarker)) {
    failures.push(
      `Release workflow must not use ${unsafeMarker}; parallel publishers can split a multi-architecture release.`,
    );
  }
}

// Notarization authenticates with an App Store Connect API key only; an
// Apple ID password would be a personal credential in CI.
for (const appleIdMarker of ["APPLE_ID", "APPLE_PASSWORD"]) {
  if (releaseWorkflow.includes(appleIdMarker)) {
    failures.push(
      `Release workflow must notarize with the App Store Connect API key, not ${appleIdMarker}.`,
    );
  }
}

// Apple secrets may only reach the steps that sign and notarize, never the
// job-wide environment where every build script and test could read them.
const macosJobHeader = releaseWorkflow.match(
  /\n  macos:\n[\s\S]*?\n    steps:\n/,
)?.[0];
if (!macosJobHeader || /secrets\.APPLE_/.test(macosJobHeader)) {
  failures.push(
    "Release workflow must scope Apple secrets to individual signing steps, not the macOS job environment.",
  );
}

if (process.env.GYRO_REQUIRE_RELEASE_SECRETS === "1") {
  for (const variable of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]) {
    if (!process.env[variable]?.trim()) {
      failures.push(`${variable} is missing from the release environment.`);
    }
  }
}

function dmgNotarizationStep(workflow) {
  const start = workflow.indexOf("- name: Sign and notarize macOS DMG");
  const end = workflow.indexOf("- name: Verify macOS DMG");
  if (start === -1 || end <= start) return "";
  return workflow.slice(start, end);
}

// Notarization gates the separate native verification job, which staples the
// downloaded DMG only after the macOS build has completed successfully.
const notaryStep = dmgNotarizationStep(releaseWorkflow);
const acceptedAt = notaryStep.indexOf('if [ "$STATUS" != "Accepted" ]');
const requeryAt = notaryStep.indexOf("xcrun notarytool info");
const exitAt = acceptedAt === -1 ? -1 : notaryStep.indexOf("exit 1", acceptedAt);
if (!notaryStep.includes("xcrun notarytool submit") ||
    !notaryStep.includes("submissions/") ||
    acceptedAt === -1 || requeryAt <= acceptedAt || exitAt <= requeryAt) {
  failures.push("DMG notarization must re-query dropped submissions and fail when the status is not Accepted.");
}
const verifyJob = releaseWorkflow.slice(
  releaseWorkflow.indexOf("\n  verify:"),
  releaseWorkflow.indexOf("\n  finalize:"),
);
if (!verifyJob.includes("needs: [signing, macos]") ||
    !verifyJob.includes("node scripts/staple-macos-artifact.mjs")) {
  failures.push("Native verification must wait for successful notarization and staple the downloaded DMG.");
}

const dmgRetryTest = spawnSync(
  process.execPath,
  [resolve(repoRoot, "scripts/check-dmg-notarization-retry.mjs")],
  { stdio: "inherit" },
);
if (dmgRetryTest.status !== 0) {
  failures.push(
    "DMG notarization retry test failed. The release workflow must re-query a dropped notarytool --wait and staple only after Accepted.",
  );
}

const dmgMountTest = spawnSync(
  process.execPath,
  [resolve(repoRoot, "scripts/verify-macos-release.mjs"), "--self-test"],
  { stdio: "inherit" },
);
if (dmgMountTest.status !== 0) {
  failures.push("DMG mount cleanup regression checks failed.");
}

const releaseRecoveryTest = spawnSync(
  process.execPath,
  [resolve(repoRoot, "scripts/check-release-recovery.mjs")],
  { stdio: "inherit" },
);
if (releaseRecoveryTest.status !== 0) {
  failures.push(
    "Release recovery must reject unapproved or unmerged source before signing.",
  );
}

if (failures.length > 0) {
  console.error("Gyro release configuration is not ready.\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error(
    "\nConfigure the Tauri updater signing key in GitHub Actions before tagging a release.",
  );
  process.exit(1);
}

console.log("Gyro release configuration looks ready.");

if (!rootPackage.scripts?.["desktop:bundle"]?.endsWith("-- --locked")) {
  throw new Error("Normal native bundles must enforce Cargo.lock.");
}
