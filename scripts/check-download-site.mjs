#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function containsAll(source, label, markers) {
  for (const marker of markers) {
    check(source.includes(marker), `${label} is missing: ${marker}`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const html = read("site/index.html");
const css = read("site/styles.css");
const app = read("site/app.js");
const buildScript = read("scripts/build-download-site.mjs");
const workflow = read(".github/workflows/pages.yml");
const fixture = JSON.parse(read("site/fixtures/latest-release.json"));

containsAll(html, "Download site HTML", [
  '<html lang="en">',
  'class="skip-link"',
  '<main id="main">',
  'id="download"',
  "Apple Silicon",
  "M1, M2, M3, M4 and newer",
  "Intel Mac",
  "No account gate",
  "No analytics",
  "macOS 14+",
  "not Apple-signed or notarized",
  "disable Gatekeeper or remove quarantine",
  "Download the correct DMG.",
  "Open it and drag Gyro to Applications.",
  "Attempt to open Gyro.",
  "Open System Settings → Privacy &amp; Security.",
  "Select Open Anyway, then confirm Open.",
  "managed Mac",
  "administrator’s security policy",
  "SHA-256",
  "Uninstall Gyro",
  "Roll back to an earlier alpha",
  "Build from source",
  "Release notes",
  "previous releases",
  "docs/privacy.md",
  "SUPPORT.md",
  "<noscript>",
  "controls\n            playsinline",
  "assets/gyro-launch-film.mp4",
  "assets/chat-thread.png",
  "assets/cli-workbench.png",
  "assets/ide.png",
]);

containsAll(css, "Download site CSS", [
  "@media (max-width: 720px)",
  "@media (prefers-reduced-motion: reduce)",
  "@media (prefers-contrast: more)",
  ":focus-visible",
  ".skip-link:focus",
]);

containsAll(app, "Download site runtime", [
  "api.github.com/repos/wytzeh197/Gyro/releases/latest",
  "selectReleaseAssets",
  "sha256FromDigest",
  "getHighEntropyValues",
  "architectureFromHints",
  "GitHub returned",
  "showReleaseFallback",
  "Confirm before downloading.",
]);

containsAll(buildScript, "Download site builder", [
  "gyro-launch-film.mp4",
  "gyro-launch-poster.png",
  "chat-thread.png",
  "cli-workbench.png",
  "ide.png",
  'writeFileSync(resolve(outputRoot, ".nojekyll")',
]);

containsAll(workflow, "Pages workflow", [
  "actions/configure-pages@v5",
  "actions/upload-pages-artifact@v3",
  "actions/deploy-pages@v4",
  "node scripts/check-download-site.mjs",
  "node scripts/build-download-site.mjs",
  "permissions:",
  "pages: write",
  "id-token: write",
  "github-pages",
]);

check(
  !/<script[^>]+src=["']https?:/i.test(html),
  "Site must not load external JavaScript",
);
check(
  !/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/i.test(html),
  "Site must not load external stylesheets",
);
for (const trackingMarker of [
  "google-analytics",
  "googletagmanager",
  "plausible.io",
  "segment.com",
  "posthog",
]) {
  check(
    !`${html}\n${app}`.toLowerCase().includes(trackingMarker),
    `Site must not contain tracking marker ${trackingMarker}`,
  );
}
check(
  !/navigator\.userAgent(?!Data)/.test(app),
  "Architecture suggestion must not inspect the compatibility user agent",
);
check(
  !/navigator\.platform/.test(app),
  "Architecture suggestion must not use navigator.platform",
);
check(
  !/(?:location|window\.location)\s*=/.test(app),
  "Site must not initiate navigation or a download automatically",
);

const referencedIds = [
  ...app.matchAll(/element\(["']([^"']+)["']\)/g),
  ...app.matchAll(/setText\(["']([^"']+)["']/g),
].map((match) => match[1]);
for (const id of new Set(referencedIds)) {
  check(
    html.includes(`id="${id}"`),
    `Runtime references missing HTML id ${id}`,
  );
}

const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(app).toString("base64")}`
);
const selected = runtime.selectReleaseAssets(fixture);
check(
  selected.appleSilicon?.name === "Gyro_9.8.7-alpha.1_aarch64.dmg",
  "Fixture Apple Silicon DMG was not selected",
);
check(
  selected.intel?.name === "Gyro_9.8.7-alpha.1_x64.dmg",
  "Fixture Intel DMG was not selected",
);
check(
  selected.checksums?.name === "SHA256SUMS",
  "Fixture SHA256SUMS was not selected",
);
check(runtime.isUsableRelease(fixture), "Fixture should be a usable release");
check(
  !runtime.isUsableRelease({ tag_name: "v1", assets: [] }),
  "Release without html_url must be rejected",
);
check(
  runtime.sha256FromDigest(fixture.assets[0].digest) === "a".repeat(64),
  "Valid GitHub SHA-256 digest was not parsed",
);
check(
  runtime.sha256FromDigest("sha256:not-a-digest") === null,
  "Malformed SHA-256 digest must be rejected",
);
check(
  runtime.formatBytes(12 * 1024 * 1024) === "12.0 MB",
  "Byte formatter changed",
);
check(
  runtime.architectureFromHints({ platform: "macOS", architecture: "arm" }) ===
    "apple-silicon",
  "Reliable macOS ARM hint must suggest Apple Silicon",
);
check(
  runtime.architectureFromHints({ platform: "macOS", architecture: "x86" }) ===
    "intel",
  "Reliable macOS x86 hint must suggest Intel",
);
check(
  runtime.architectureFromHints({
    platform: "Windows",
    architecture: "arm",
  }) === null,
  "Non-macOS architecture hints must not make a Mac suggestion",
);
check(
  runtime.architectureFromHints({ platform: "macOS", architecture: "" }) ===
    null,
  "Missing architecture hint must not make a suggestion",
);

const buildRoot = mkdtempSync(resolve(tmpdir(), "gyro-download-site-"));
try {
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/build-download-site.mjs"),
      "--output",
      buildRoot,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  check(
    result.status === 0,
    `Builder failed: ${(result.stderr || result.stdout).trim()}`,
  );

  const expectedOutputs = [
    "index.html",
    "styles.css",
    "app.js",
    ".nojekyll",
    "assets/gyro-logo.png",
    "assets/gyro-launch-film.mp4",
    "assets/gyro-launch-poster.png",
    "assets/chat-thread.png",
    "assets/cli-workbench.png",
    "assets/ide.png",
  ];
  for (const path of expectedOutputs) {
    const absolute = resolve(buildRoot, path);
    check(existsSync(absolute), `Built site is missing ${path}`);
    if (existsSync(absolute) && path !== ".nojekyll") {
      check(statSync(absolute).size > 0, `Built site output ${path} is empty`);
    }
  }

  const copiedAssets = [
    ["docs/media/launch/gyro-launch-film.mp4", "assets/gyro-launch-film.mp4"],
    [
      "docs/media/launch/gyro-launch-poster.png",
      "assets/gyro-launch-poster.png",
    ],
    ["docs/screenshots/chat-thread.png", "assets/chat-thread.png"],
    ["docs/screenshots/cli-workbench.png", "assets/cli-workbench.png"],
    ["docs/screenshots/ide.png", "assets/ide.png"],
  ];
  for (const [source, destination] of copiedAssets) {
    if (existsSync(resolve(buildRoot, destination))) {
      check(
        sha256(resolve(repoRoot, source)) ===
          sha256(resolve(buildRoot, destination)),
        `Built asset differs from ${source}`,
      );
    }
  }
} finally {
  rmSync(buildRoot, { force: true, recursive: true });
}

if (failures.length) {
  console.error("Download site checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "Download site source, fixtures, copied media, and Pages workflow are valid.",
);
