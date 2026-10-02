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

await import("./check-download-site-runtime.mjs");
await import("./check-download-site-build.mjs");

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

function pngDimensions(path) {
  const bytes = readFileSync(path);
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString() !== "IHDR"
  ) {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const screenshotAssets = [
  "current-chat-light.webp",
  "current-chat-dark.webp",
  "current-workspace-light.webp",
  "current-workspace-dark.webp",
  "current-review-light.webp",
  "current-review-dark.webp",
  "current-review-wide-light.webp",
  "current-review-wide-dark.webp",
].map((file) => `assets/screenshots/${file}`);

const cropSpecs = JSON.parse(read("site/assets/screenshots/editorial-crops.json"));
const derivedAssets = Object.keys(cropSpecs);
const approvedAssets = [...screenshotAssets, ...derivedAssets];

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
    '<html lang="en" data-theme="light">',
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
    "data-theme-toggle",
    "theme.js",
  ]);
}

containsAll(headers, "Cloudflare Pages headers", [
  "/*",
  "Content-Security-Policy:",
  "Permissions-Policy:",
  "Referrer-Policy: same-origin",
  "Strict-Transport-Security: max-age=",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
]);
// A published model can only reach a picker as fast as the edge hands the
// catalog over, so it must not be cached longer than a focused poll interval.
check(
  headers.includes(
    "/model-catalog.json\n  Cache-Control: public, max-age=60, must-revalidate",
  ),
  "site/_headers must revalidate /model-catalog.json within a minute",
);
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
for (const [name, html] of Object.entries(pages)) {
  const themeScript = html.indexOf("theme.js");
  const stylesheet = html.indexOf("styles.css");
  check(
    themeScript !== -1 && themeScript < stylesheet,
    `${name} page must load theme.js before styles.css so the stored theme applies before first paint`,
  );
}
// The toggle lives in theme.js, not app.js: the changelog and privacy pages
// carry the header toggle but never load app.js.
containsAll(read("site/theme.js"), "Theme runtime", [
  "gyro.site-theme",
  "data-theme-toggle",
  "addEventListener",
  'stored() === "dark" ? "dark" : "light"',
]);
check(
  !app.includes("data-theme-toggle"),
  "The theme toggle must be wired in theme.js, which every page loads",
);
for (const [name, html] of Object.entries(pages)) {
  check(
    html.includes("data-theme-toggle"),
    `${name} page must expose the header theme toggle`,
  );
  check(
    html.includes('content="#ffffff"'),
    `${name} page must default theme-color to white`,
  );
  check(
    html.includes('aria-label="Switch to dark theme"'),
    `${name} page must default the theme toggle to light`,
  );
}

containsAll(pages.home, "Homepage", [
  "A place to think. A space to build.", "workspace-switcher", "ownership-title",
  "Public alpha", "One task.<br />Three views.", "Direct the work", "Run it locally",
  "IDE Workspace", "assets/gyro-mark.png", 'class="spine"', 'class="surface-card"',
  "Your setup, your call.", "data-agent-rotator", 'class="agent-slot"',
  'class="agent-roster"', "data-agent-toggle", "data-agent-selected",
  ...["Claude Code", "Codex", "Gemini CLI", "Grok Build", "Kimi Code", "Cursor",
    "OpenCode", "Ollama", "OpenRouter", "DeepSeek", "Mistral"]
    .map((name) => `<span class="visually-hidden">${name}</span>`),
  'src="agents.js"', ...derivedAssets, "assets/social-preview.png",
  "Built for macOS 14+. Fully open source.",
  "Your agents, terminal, and IDE Workspace in one place — and fully open source.",
  "See how it works", "See what changed.", "Bring your setup.",
  'data-start-provider="claude"', 'data-start-provider="openai"', 'data-start-provider="grok"',
  "Start building with Gyro.", "Download for macOS", "Apple Silicon", "Intel",
  "Install guide", "What do I need to get started?", "data-download-surface",
]);
check(pages.home.includes('Coding with AI,<br class="hero-break" /> done better.'),
  "The approved hero headline and desktop line break must remain intact");
const sectionOrder = ["editorial-hero", "proof-strip", "agents-section", "editorial-product",
  "editorial-review", "editorial-ownership", "editorial-start", "editorial-download", "editorial-faq"];
const homepageSections = [...pages.home.matchAll(/<section\b[^>]*class="([^"]+)"/g)]
  .map((match) => match[1].split(" ")[0]);
check(JSON.stringify(homepageSections) === JSON.stringify(sectionOrder),
  "Homepage must use all nine main sections in the approved order, followed by the footer");
for (const anchor of ["product", "agents", "review", "ownership", "getting-started", "download"])
  check(pages.home.includes(`id="${anchor}"`), `Missing approved anchor #${anchor}`);
check((pages.home.match(/data-agent-pick/g) ?? []).length === 11,
  "The supported roster must retain exactly eleven providers");
check((pages.home.match(/<details>/g) ?? []).length === 5,
  "The FAQ must retain five collapsed native disclosures");
check(!pages.home.includes('<details open'), "FAQ answers must start collapsed");
for (const [name, html] of Object.entries(pages)) {
  check(html.includes('class="mobile-nav"'), `${name} must contain native mobile navigation`);
  check(html.includes('class="footer-wordmark" aria-hidden="true"'), `${name} wordmark must be decorative`);
}
check(!read("site/theme.js").includes("createElement(\"canvas\")"), "Theme must not create the decorative pointer canvas");

// Product captures use the real interface and describe the demonstrated state.
const productImages = [...pages.home.matchAll(/<img\b[^>]*>/gs)]
  .map(([tag]) => tag)
  .filter((tag) => tag.includes("assets/screenshots/"));
for (const tag of productImages) {
  const path = tag.match(/\bsrc="([^"]+)"/)?.[1];
  const spec = cropSpecs[path];
  check(spec && /\balt="[^"]+"/.test(tag) &&
      tag.includes(`width="${spec.width}"`) && tag.includes(`height="${spec.height}"`),
    `${path} must carry descriptive alt text and its exact derivative dimensions`);
}
for (const [,tag,path,width,height] of pages.home.matchAll(/(<source\b[^>]*srcset="([^"]+)"[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*>)/g)) {
  const spec = cropSpecs[path];
  check(spec?.width === Number(width) && spec?.height === Number(height),
    `${path} must reserve its exact mobile crop dimensions`);
}

check(
  (pages.home.match(/data-download-surface/g) ?? []).length === 1,
  "Homepage must contain one compact download surface",
);
check(
  !pages.home.includes("Agent chat, terminal, and code review. All on your Mac."),
  "Homepage hero must not include the removed subtitle",
);
check(
  !pages.home.includes("Sample project") &&
    !pages.home.includes("Sample session"),
  "Homepage must not include the removed hero caption detail",
);
check(
  !pages.home.includes("Product preview"),
  "Product captures must not be labeled as previews",
);
check(
  pages.home.indexOf('id="agents"') < pages.home.indexOf('id="product"'),
  "Provider roster must precede the product demonstration",
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
  !css
    .replace(/\.home-page \.product-stage-frame::after\s*\{[^}]*\}/g, "")
    .toLowerCase()
    .includes("gradient("),
  "Gradients are limited to the requested screenshot outline",
);
check(
  [...allHtml.matchAll(/assets\/screenshots\/[^\s"'<>]+/g)].every(([path]) =>
    approvedAssets.includes(path),
  ),
  "Pages must reference only the current product screenshots",
);
// Every demonstrated surface has a fresh capture for both site themes.
const spineStart = pages.home.indexOf('<ol class="spine">');
const spineEnd = pages.home.indexOf("</ol>", spineStart);
const spine = pages.home.slice(spineStart, spineEnd);
check(
  spineStart !== -1 &&
    spineEnd !== -1 &&
    ["chat", "terminal", "ide"].every((name) => ["light", "dark"].every((theme) => spine.includes(`editorial-${name}-${theme}.webp`))) &&
    !/class="mock(?:\s|")/.test(spine),
  "Product surfaces must show current chat, workspace, and review captures in both themes",
);

containsAll(pages.install, "Install page", [
  "Download Gyro for macOS.",
  "Choose your build, then follow the setup steps below.",
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
  "Release notes for the Gyro AI coding workspace for macOS.",
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
  "--shell: min(1120px, calc(100% - 96px))", "--header-height: 72px",
  "min-height: 44px", ".surface-card", ".capture-frame", ".agent-roster", ".agent-slot",
  ':root[data-theme="light"]', ".theme-toggle", "--mono:", "--sans:", "--display:",
  ".spine", ".changelog-layout", ".version-rail nav", ".legal-layout", "scroll-margin-top:",
  ".site-header {\n  position: sticky;\n  z-index: 50;\n  top: 0;", "width: 100%",
  ":focus-visible", "@media (max-width: 900px)", "@media (max-width: 720px)",
  "@media (max-width: 390px)", "@media (prefers-reduced-motion: reduce)",
  "@media (prefers-contrast: more)", "--agent-cycle: 4500ms", ".ownership-screen",
]);

// Both webfonts are served from this origin. There is no font-src in the CSP,
// so it falls back to default-src 'self' and any CDN would be blocked.
for (const font of ["inter-latin.woff2", "inter-tight-latin.woff2"]) {
  check(
    css.includes(`url("assets/fonts/${font}")`),
    `Shared CSS must serve ${font} from this origin`,
  );
  check(
    pages.home.includes(`href="assets/fonts/${font}"`),
    `Homepage must preload ${font}`,
  );
}
check(
  (css.match(/@font-face/g) ?? []).length === 2,
  "Shared CSS must declare exactly the two self-hosted faces",
);
check(
  /font-display:\s*swap/.test(css),
  "Webfaces must use font-display: swap so text paints before they arrive",
);

// The high-contrast override started life as a light-theme-only palette, which
// left dark mode with near-black text on a near-black page.
check(
  /@media \(prefers-contrast: more\) \{[\s\S]*?:root\[data-theme="light"\]/.test(
    css,
  ),
  "The high-contrast override must carry a set for each theme",
);

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
  '"site/theme.js", "theme.js"',
  "site/changelog.js",
  "site/assets/fonts/inter-latin.woff2",
  "site/assets/fonts/inter-tight-latin.woff2",
  "site/assets/gyro-mark.png",
  "site/assets/social-preview.png",
  ...approvedAssets.map((path) => `site/${path}`),
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

// style-src 'self' blocks inline style attributes, so positioning has to live
// in the stylesheet. This catches the silent-failure mode.
check(
  !/<[a-z][^>]*\sstyle=/i.test(allHtml),
  "Pages must not use inline style attributes; the CSP blocks them",
);
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

// Original masters are 1440x900 at 2x; the expanded Review masters are 960x600 at 1x.
const masterDimensions = Object.fromEntries(screenshotAssets.map((path) =>
  [path, path.includes("-wide-") ? [960, 600] : [2880, 1800]]));
const screenshotSpecs = [
  ...screenshotAssets.map((path) => [`site/${path}`, ...masterDimensions[path]]),
  ...Object.entries(cropSpecs).map(([path, spec]) => [`site/${path}`, spec.width, spec.height]),
  ["site/assets/ownership-device.webp", 1586, 992],
];
check(derivedAssets.length === 24, "The approved crop manifest must contain twelve light/dark pairs");
for (const [path, spec] of Object.entries(cropSpecs)) {
  const [left, top, right, bottom] = spec.crop;
  const masterSize = masterDimensions[`assets/screenshots/${spec.master}`];
  check(masterSize &&
    left >= 0 && top >= 0 && right <= masterSize[0] && bottom <= masterSize[1] &&
    right - left === spec.width && bottom - top === spec.height,
    `${path} must be an aspect-preserving crop of an approved master`);
}
check(statSync(resolve(repoRoot, "site/assets/ownership-device.webp")).size <= 400_000,
  "The ownership device must stay within its 400KB budget");
for (const [path, width, height] of screenshotSpecs) {
  const dimensions = webpDimensions(resolve(repoRoot, path));
  check(
    dimensions?.width === width && dimensions?.height === height,
    `${path} must be ${width}x${height}; found ${dimensions ? `${dimensions.width}x${dimensions.height}` : "invalid WebP"}`,
  );
}
const socialPreviewDimensions = pngDimensions(
  resolve(repoRoot, "site/assets/social-preview.png"),
);
check(
  socialPreviewDimensions?.width === 1200 &&
    socialPreviewDimensions?.height === 630,
  "site/assets/social-preview.png must be a 1200x630 PNG",
);

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
    "theme.js",
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
  check(
    JSON.stringify(
      filesA.filter((file) => file.startsWith("assets/screenshots/")).sort(),
    ) === JSON.stringify([...approvedAssets, "assets/screenshots/editorial-crops.json"].sort()),
    "Built site must contain only the eight authentic masters, approved derivatives, and their crop manifest",
  );
}

rmSync(tempRoot, { force: true, recursive: true });

if (failures.length) {
  console.error("Download site checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Download site checks passed.");
