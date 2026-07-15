#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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

function pngDimensions(path) {
  const bytes = readFileSync(path);
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a" || bytes.length < 24) return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
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
  'id="top"',
  'id="product"',
  'id="download"',
  'id="install"',
  "Keep the whole coding run together.",
  "Chat, terminals, files, diffs, and approvals in one local workspace.",
  "Open source · No account · No analytics",
  "One run. Three surfaces.",
  "Direct the work.",
  "Run it locally.",
  "Review every change.",
  "Local by default.",
  "No Gyro account",
  "No analytics",
  "assets/gyro-logo.png",
  "assets/apple.svg",
  "assets/github.svg",
  "assets/hero-workbench.png",
  "assets/chat-surface.png",
  "assets/cli-surface.png",
  "assets/workspace-surface.png",
  'content="https://wytzeh197.github.io/Gyro/assets/hero-workbench.png"',
  "Download Gyro",
  "DMG · macOS 14+",
  'id="architecture-apple-silicon"',
  'id="architecture-intel"',
  'type="radio"',
  'name="architecture"',
  'id="download-selected"',
  'id="download-selected-label"',
  "Open GitHub Releases",
  "Nothing downloads automatically.",
  "Unsigned public alpha",
  "Never disable Gatekeeper or remove quarantine.",
  "Move Gyro to Applications.",
  "Try to open Gyro once.",
  "Choose Open Anyway.",
  "managed Mac",
  "administrator’s",
  'id="selected-digest"',
  'id="copy-checksum"',
  'id="checksum-command"',
  "Uninstall or roll back",
  "Build from source",
  "Release notes",
  "previous releases",
  "docs/privacy.md",
  "SUPPORT.md",
  "<noscript>",
]);

check(
  (html.match(/<section\b/g) ?? []).length === 5,
  "Site must contain exactly five major sections",
);
check(
  (html.match(/class="macos-card"/g) ?? []).length === 1,
  "Site must contain exactly one macOS download card",
);

containsAll(css, "Download site CSS", [
  "--shell: min(1152px, calc(100% - 48px))",
  "min-height: 64px",
  "font-size: 56px",
  "font-size: 40px",
  "font-size: 21px",
  "font-size: 16px",
  "font-size: 13px",
  "padding: 88px 0",
  "min-height: 44px",
  ".release-meta a,",
  ".unsigned-notice div > a,",
  ".managed-warning a,",
  ".detail-content > a",
  "scroll-padding-top:",
  "aspect-ratio: 4 / 3",
  "overflow-wrap: normal",
  "word-break: normal",
  ":focus-visible",
  ".skip-link:focus",
  "@media (max-width: 720px)",
  "@media (max-width: 390px)",
  "@media (prefers-reduced-motion: reduce)",
  "@media (prefers-contrast: more)",
]);

containsAll(app, "Download site runtime", [
  "api.github.com/repos/wytzeh197/Gyro/releases/latest",
  'DEFAULT_ARCHITECTURE = "apple-silicon"',
  "selectedArchitecture",
  "selectReleaseAssets",
  "sha256FromDigest",
  "getHighEntropyValues",
  "architectureFromHints",
  "architecture-${architecture}",
  'input?.addEventListener("change"',
  "configureSelectedDownload",
  "copySelectedChecksum",
  "RELEASE_REQUEST_TIMEOUT_MS",
  "AbortController",
  "signal: controller.signal",
  "Open GitHub Releases",
  "isOutdatedReleaseLine",
  "parseReleaseNoteBlocks",
  "GitHub returned",
  "showReleaseFallback",
  "Confirm before downloading.",
]);

containsAll(buildScript, "Download site builder", [
  "site/assets/apple.svg",
  "site/assets/github.svg",
  "site/assets/ATTRIBUTIONS.md",
  "site/assets/hero-workbench.png",
  "site/assets/chat-surface.png",
  "site/assets/cli-surface.png",
  "site/assets/workspace-surface.png",
  'writeFileSync(resolve(outputRoot, ".nojekyll")',
]);

const undersizedPixelFonts = [...css.matchAll(/font-size:\s*(\d+)px/g)]
  .map((match) => Number(match[1]))
  .filter((size) => size < 13);
check(
  undersizedPixelFonts.length === 0,
  `Site metadata must be at least 13px; found ${undersizedPixelFonts.join(", ")}`,
);

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

for (const staleMarker of [
  "Private preview",
  "gyro-launch-film",
  "gyro-launch-poster",
  "chat-thread.png",
  "cli-workbench.png",
  "assets/ide.png",
]) {
  check(
    !`${html}\n${css}\n${app}\n${buildScript}\n${workflow}`.includes(
      staleMarker,
    ),
    `Site must not contain stale media marker ${staleMarker}`,
  );
}

check(
  !/<script[^>]+src=["']https?:/i.test(html),
  "Site must not load external JavaScript",
);
check(
  !/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/i.test(html),
  "Site must not load external stylesheets",
);
check(
  !/<img[^>]+src=["']https?:/i.test(html),
  "Site must not load external images",
);
check(
  !/@import\s+(?:url\()?['"]?https?:/i.test(css) &&
    !/url\(['"]?https?:/i.test(css),
  "Site must not load external fonts or CSS assets",
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
const missingIntel = runtime.selectReleaseAssets({
  ...fixture,
  assets: fixture.assets.filter((asset) => !asset.name.includes("_x64.dmg")),
});
check(
  missingIntel.appleSilicon && !missingIntel.intel,
  "A release with a missing Intel DMG must preserve only the available build",
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
check(
  runtime.isOutdatedReleaseLine("The launch film is included below."),
  "Outdated launch-film release-note lines must be filtered",
);
check(
  runtime.isOutdatedReleaseLine("Private preview soon"),
  "Outdated private-preview release-note lines must be filtered",
);
check(
  !runtime.isOutdatedReleaseLine("Native macOS downloads are available."),
  "Current release-note lines must remain visible",
);
const parsedReleaseNotes = runtime.parseReleaseNoteBlocks(`## What changed

- One wrapped list item that
  continues on the next line.

\`\`\`bash
gyro doctor --json
\`\`\``);
check(
  parsedReleaseNotes[1]?.type === "list" &&
    parsedReleaseNotes[1]?.items[0] ===
      "One wrapped list item that continues on the next line.",
  "Wrapped release-note list items must remain intact",
);
check(
  parsedReleaseNotes[2]?.type === "code" &&
    parsedReleaseNotes[2]?.text === "gyro doctor --json",
  "Release-note code fences must render as one code block",
);

const screenshotSpecs = [
  ["site/assets/hero-workbench.png", 1600, 1000],
  ["site/assets/chat-surface.png", 1200, 900],
  ["site/assets/cli-surface.png", 1200, 900],
  ["site/assets/workspace-surface.png", 1200, 900],
];
for (const [path, width, height] of screenshotSpecs) {
  const absolute = resolve(repoRoot, path);
  check(existsSync(absolute), `Required screenshot is missing: ${path}`);
  if (!existsSync(absolute)) continue;
  const dimensions = pngDimensions(absolute);
  check(Boolean(dimensions), `${path} must be a valid PNG`);
  check(
    dimensions?.width === width && dimensions?.height === height,
    `${path} must be ${width}x${height}`,
  );
}

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
    "assets/apple.svg",
    "assets/github.svg",
    "assets/ATTRIBUTIONS.md",
    "assets/hero-workbench.png",
    "assets/chat-surface.png",
    "assets/cli-surface.png",
    "assets/workspace-surface.png",
  ];
  for (const path of expectedOutputs) {
    const absolute = resolve(buildRoot, path);
    check(existsSync(absolute), `Built site is missing ${path}`);
    if (existsSync(absolute) && path !== ".nojekyll") {
      check(statSync(absolute).size > 0, `Built site output ${path} is empty`);
    }
  }

  const copiedAssets = [
    ["apps/desktop/src-tauri/icons/icon.png", "assets/gyro-logo.png"],
    ["site/assets/apple.svg", "assets/apple.svg"],
    ["site/assets/github.svg", "assets/github.svg"],
    ["site/assets/ATTRIBUTIONS.md", "assets/ATTRIBUTIONS.md"],
    ...screenshotSpecs.map(([source]) => [source, source.replace("site/", "")]),
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

  for (const staleOutput of [
    "assets/gyro-launch-film.mp4",
    "assets/gyro-launch-poster.png",
    "assets/chat-thread.png",
    "assets/cli-workbench.png",
    "assets/ide.png",
  ]) {
    check(
      !existsSync(resolve(buildRoot, staleOutput)),
      `Built site must not contain ${staleOutput}`,
    );
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
  "Download site layout, runtime, fixtures, local media, and Pages workflow are valid.",
);
