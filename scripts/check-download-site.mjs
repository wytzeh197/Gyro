#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
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

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(root, path));
    }
  }
  walk(root);
  return files.sort();
}

function webpDimensions(path) {
  const bytes = readFileSync(path);
  if (
    bytes.subarray(0, 4).toString() !== "RIFF" ||
    bytes.subarray(8, 12).toString() !== "WEBP"
  ) {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString();
    const size = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (type === "VP8X" && size >= 10) {
      return {
        width: 1 + bytes.readUIntLE(data + 4, 3),
        height: 1 + bytes.readUIntLE(data + 7, 3),
      };
    }
    if (type === "VP8 " && size >= 10) {
      for (
        let index = data;
        index < Math.min(data + size - 9, bytes.length - 9);
        index += 1
      ) {
        if (
          bytes[index] === 0x9d &&
          bytes[index + 1] === 0x01 &&
          bytes[index + 2] === 0x2a
        ) {
          return {
            width: bytes.readUInt16LE(index + 3) & 0x3fff,
            height: bytes.readUInt16LE(index + 5) & 0x3fff,
          };
        }
      }
    }
    if (type === "VP8L" && size >= 5 && bytes[data] === 0x2f) {
      const bits = bytes.readUInt32LE(data + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    offset = data + size + (size % 2);
  }
  return null;
}

const pages = {
  home: read("site/index.html"),
  install: read("site/install/index.html"),
  changelog: read("site/changelog/index.html"),
  privacy: read("site/privacy/index.html"),
};
const allHtml = Object.values(pages).join("\n");
const css = read("site/styles.css");
const app = read("site/app.js");
const releaseUtils = read("site/release-utils.js");
const changelogJs = read("site/changelog.js");
const headers = read("site/_headers");
const robots = read("site/robots.txt");
const sitemap = read("site/sitemap.xml");
const buildScript = read("scripts/build-download-site.mjs");
const fixture = JSON.parse(read("site/fixtures/latest-release.json"));

for (const [name, html] of Object.entries(pages)) {
  containsAll(html, `${name} page`, [
    '<html lang="en">',
    'class="skip-link"',
    '<main id="main">',
    "Content-Security-Policy",
    "base-uri 'none'",
    'rel="canonical"',
    "Product",
    "Install",
    "Changelog",
    "GitHub",
    "Download",
    "Privacy &amp; Legal",
    "Support",
    "Security",
    "License",
    "Attributions",
    "Source",
  ]);
}

containsAll(headers, "Cloudflare Pages headers", [
  "/*",
  "Content-Security-Policy:",
  "Permissions-Policy:",
  "Referrer-Policy: same-origin",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
]);
containsAll(robots, "robots.txt", [
  "User-agent: *",
  "Allow: /",
  "Sitemap: https://usegyro.io/sitemap.xml",
]);
for (const url of [
  "https://usegyro.io/",
  "https://usegyro.io/install/",
  "https://usegyro.io/changelog/",
  "https://usegyro.io/privacy/",
]) {
  check(sitemap.includes(`<loc>${url}</loc>`), `Sitemap is missing ${url}`);
}
check(
  !allHtml.includes("wytzeh197.github.io/Gyro"),
  "Pages must use usegyro.io as their canonical public origin",
);

containsAll(pages.home, "Homepage", [
  "Chat, CLI, and IDE. One place.",
  "Stop switching tools for one coding task.",
  "Open source · No account · No analytics",
  "One task. Three connected surfaces.",
  "Direct the work.",
  "Run it locally.",
  "Review every change.",
  "assets/gyro-mark.png",
  'class="surface-card surface-card-wide"',
  'class="surface-pair"',
  'class="surface-visual"',
  "assets/screenshots/hero-960.webp",
  "assets/screenshots/hero-1920.webp",
  "assets/screenshots/hero-mobile-1200.webp",
  "assets/screenshots/chat-1600.webp",
  "assets/screenshots/cli-1600.webp",
  "assets/screenshots/workspace-1600.webp",
  "assets/social-preview.png",
  "Download Gyro for macOS.",
  "The local workspace that keeps chat, CLI, and code together.",
  "DMG · Apple Silicon &amp; Intel",
  "Install guide",
  "data-download-surface",
]);

check(
  (pages.home.match(/data-download-surface/g) ?? []).length === 1,
  "Homepage must contain one compact download surface",
);
check(
  !pages.home.includes("Move Gyro to Applications."),
  "Homepage must not contain the full first-launch guide",
);
check(
  !pages.home.includes("Unsigned public alpha"),
  "Homepage must not contain the removed unsigned warning panel",
);
check(
  !pages.home.includes("Recommended for this Mac") &&
    !pages.install.includes("Recommended for this Mac"),
  "Download pages must not show an automatic recommendation sentence",
);
check(
  !css.toLowerCase().includes("gradient("),
  "Site styles must not contain gradient backgrounds",
);

containsAll(pages.install, "Install page", [
  "Download Gyro.",
  "Choose Apple Silicon or Intel.",
  "Choose your Mac processor",
  "Apple Silicon",
  "M1–M4 and newer",
  "Intel",
  "Download DMG",
  "Verify download",
  "SHA-256 for selected DMG",
  'data-role="copy-checksum"',
  "Updates and rollback",
  "Uninstall Gyro",
  "brew tap wytzeh197/tap",
  "Build from source",
  "Troubleshooting and support",
]);

check(
  !pages.install.includes("Unsigned public alpha"),
  "Install page must not repeat the unsigned alpha warning",
);

check(
  !pages.install.includes('class="install-guide') &&
    !pages.install.includes("Open Gyro safely.") &&
    !pages.install.includes("Choose Open Anyway."),
  "Install page must not contain the removed first-launch section",
);

containsAll(pages.changelog, "Changelog page", [
  "Every published alpha from version 21 onward.",
  "data-version-rail",
  "data-version-jump",
  "data-changelog-list",
  "data-changelog-fallback",
  "<noscript",
]);

containsAll(pages.privacy, "Privacy page", [
  "Privacy &amp; Legal.",
  "Local sessions and settings",
  "What model providers receive",
  "Telemetry and this website",
  "Delete your data",
  "Public alpha, license, and support",
  "Trademarks and assets",
  "Security and support",
  "Last updated 22 July 2026",
]);

containsAll(css, "Shared CSS", [
  "--shell: min(1152px, calc(100% - 48px))",
  "--header-height: 64px",
  "font-size: 56px",
  "font-size: 40px",
  "font-size: 21px",
  "font-size: 16px",
  "font-size: 13px",
  "min-height: 44px",
  ".surface-card-wide",
  ".surface-visual",
  "--grid-columns: 12",
  "grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr))",
  "grid-template-columns: minmax(260px, 32%) minmax(0, 68%)",
  ".surface-pair",
  ".changelog-layout",
  ".version-rail nav",
  ".legal-layout",
  "scroll-margin-top:",
  ":focus-visible",
  "@media (max-width: 900px)",
  "@media (max-width: 720px)",
  "@media (max-width: 390px)",
  "@media (prefers-reduced-motion: reduce)",
  "@media (prefers-contrast: more)",
]);

containsAll(app, "Download runtime", [
  "LATEST_RELEASE_API",
  'DEFAULT_ARCHITECTURE = "apple-silicon"',
  "selectedArchitecture",
  "selectReleaseAssets",
  "sha256FromDigest",
  "getHighEntropyValues",
  "architectureFromHints",
  "configureSelectedDownload",
  "copyChecksum",
]);

containsAll(changelogJs, "Changelog runtime", [
  "RELEASES_API",
  "isPublicAlphaRelease",
  "releaseAnchor",
  "renderReleaseNotes",
  "textContent",
  "data-changelog-list",
]);

containsAll(releaseUtils, "Shared release utilities", [
  "releases?per_page=30",
  "REQUEST_TIMEOUT_MS = 8000",
  "parseReleaseNoteBlocks",
  "isOutdatedReleaseText",
  "isPublicAlphaRelease",
  "AbortController",
]);

containsAll(buildScript, "Site builder", [
  '"site/_headers", "_headers"',
  '"site/robots.txt", "robots.txt"',
  '"site/sitemap.xml", "sitemap.xml"',
  "site/install/index.html",
  "site/changelog/index.html",
  "site/privacy/index.html",
  "site/release-utils.js",
  "site/changelog.js",
  "site/assets/gyro-mark.png",
  "site/assets/social-preview.png",
  "site/assets/screenshots/hero-1920.webp",
  "site/assets/screenshots/workspace-1600.webp",
  'writeFileSync(resolve(outputRoot, ".nojekyll")',
]);

for (const staleMarker of [
  "Private preview",
  "gyro-launch-film",
  "gyro-launch-poster",
  "hero-workbench.png",
  "chat-surface.png",
  "cli-surface.png",
  "workspace-surface.png",
]) {
  check(
    !`${allHtml}\n${css}\n${app}\n${changelogJs}\n${buildScript}`.includes(
      staleMarker,
    ),
    `Site output inputs must not contain stale marker ${staleMarker}`,
  );
}

check(
  !/<script[^>]+src=["']https?:/i.test(allHtml),
  "Pages must not load remote scripts",
);
check(
  !/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/i.test(allHtml),
  "Pages must not load remote styles",
);
check(
  !/<img[^>]+(?:src|srcset)=["'][^"']*https?:/i.test(allHtml),
  "Pages must not load remote images",
);
check(
  !/@import\s+(?:url\()?['"]?https?:/i.test(css) &&
    !/url\(['"]?https?:/i.test(css),
  "CSS must not load remote assets",
);
check(
  !/navigator\.userAgent(?!Data)/.test(app),
  "Architecture detection must not use the compatibility user agent",
);
check(
  !/navigator\.platform/.test(app),
  "Architecture detection must not use navigator.platform",
);
check(
  !/(?:location|window\.location)\s*=/.test(app),
  "Runtime must not navigate or download automatically",
);

for (const trackingMarker of [
  "google-analytics",
  "googletagmanager",
  "plausible.io",
  "segment.com",
  "posthog",
]) {
  check(
    !`${allHtml}\n${app}\n${changelogJs}`
      .toLowerCase()
      .includes(trackingMarker),
    `Site contains tracking marker ${trackingMarker}`,
  );
}

const undersizedPixelFonts = [...css.matchAll(/font-size:\s*(\d+)px/g)]
  .map((match) => Number(match[1]))
  .filter((size) => size < 13);
check(
  undersizedPixelFonts.length === 0,
  `Site text must be at least 13px; found ${undersizedPixelFonts.join(", ")}`,
);

const screenshotSpecs = [
  ["site/assets/screenshots/hero-960.webp", 960, 540],
  ["site/assets/screenshots/hero-1920.webp", 1920, 1080],
  ["site/assets/screenshots/hero-mobile-600.webp", 600, 480],
  ["site/assets/screenshots/hero-mobile-1200.webp", 1200, 960],
  ["site/assets/screenshots/chat-800.webp", 800, 450],
  ["site/assets/screenshots/chat-1600.webp", 1600, 900],
  ["site/assets/screenshots/cli-800.webp", 800, 450],
  ["site/assets/screenshots/cli-1600.webp", 1600, 900],
  ["site/assets/screenshots/workspace-800.webp", 800, 450],
  ["site/assets/screenshots/workspace-1600.webp", 1600, 900],
];
for (const [path, width, height] of screenshotSpecs) {
  const dimensions = webpDimensions(resolve(repoRoot, path));
  check(
    dimensions?.width === width && dimensions?.height === height,
    `${path} must be ${width}x${height}; found ${dimensions ? `${dimensions.width}x${dimensions.height}` : "invalid WebP"}`,
  );
}

const utilityRuntime = await import(
  `data:text/javascript;base64,${Buffer.from(releaseUtils).toString("base64")}`
);
const assets = utilityRuntime.selectReleaseAssets(fixture);
check(
  assets.appleSilicon?.name === "Gyro_9.8.7-alpha.1_aarch64.dmg",
  "Fixture Apple Silicon DMG was not selected",
);
check(
  assets.intel?.name === "Gyro_9.8.7-alpha.1_x64.dmg",
  "Fixture Intel DMG was not selected",
);
check(
  assets.checksums?.name === "SHA256SUMS",
  "Fixture SHA256SUMS was not selected",
);
check(
  utilityRuntime.sha256FromDigest(fixture.assets[0].digest) === "a".repeat(64),
  "SHA-256 digest parsing changed",
);
check(
  utilityRuntime.architectureFromHints({
    platform: "macOS",
    architecture: "arm",
  }) === "apple-silicon",
  "macOS ARM hint must suggest Apple Silicon",
);
check(
  utilityRuntime.architectureFromHints({
    platform: "macOS",
    architecture: "x86",
  }) === "intel",
  "macOS x86 hint must suggest Intel",
);
check(
  utilityRuntime.architectureFromHints({
    platform: "Windows",
    architecture: "arm",
  }) === null,
  "Non-macOS hints must not suggest a Mac build",
);
check(
  utilityRuntime.isPublicAlphaRelease({
    ...fixture,
    tag_name: "v0.1.0-alpha.21",
    draft: false,
  }),
  "Alpha 21 must be public",
);
check(
  !utilityRuntime.isPublicAlphaRelease({
    ...fixture,
    tag_name: "v0.1.0-alpha.20",
    draft: false,
  }),
  "Alpha 20 must be excluded",
);
check(
  !utilityRuntime.isPublicAlphaRelease({
    ...fixture,
    tag_name: "v1.0.0",
    draft: false,
  }),
  "Non-alpha releases must be excluded",
);
check(
  utilityRuntime.isOutdatedReleaseText("The launch film is included below."),
  "Launch-film lines must be filtered",
);

const tempRoot = mkdtempSync(resolve(tmpdir(), "gyro-site-check-"));
const buildA = resolve(tempRoot, "a");
const buildB = resolve(tempRoot, "b");
for (const output of [buildA, buildB]) {
  const result = spawnSync(
    process.execPath,
    ["scripts/build-download-site.mjs", "--output", output],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  check(
    result.status === 0,
    `Site build failed: ${result.stderr || result.stdout}`,
  );
}

if (!failures.length) {
  const filesA = listFiles(buildA);
  const filesB = listFiles(buildB);
  check(
    JSON.stringify(filesA) === JSON.stringify(filesB),
    "Site builds produced different file manifests",
  );
  for (const file of filesA) {
    check(
      fileHash(resolve(buildA, file)) === fileHash(resolve(buildB, file)),
      `Site build is not deterministic for ${file}`,
    );
  }
  for (const route of [
    "_headers",
    "index.html",
    "install/index.html",
    "changelog/index.html",
    "privacy/index.html",
    "robots.txt",
    "sitemap.xml",
  ]) {
    check(filesA.includes(route), `Built site is missing route ${route}`);
  }
  for (const stale of [
    "assets/hero-workbench.png",
    "assets/chat-surface.png",
    "assets/cli-surface.png",
    "assets/workspace-surface.png",
  ]) {
    check(!filesA.includes(stale), `Built site contains stale asset ${stale}`);
  }
}

rmSync(tempRoot, { force: true, recursive: true });

if (failures.length) {
  console.error("Download site checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Download site checks passed.");
