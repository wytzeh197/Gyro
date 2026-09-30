#!/usr/bin/env node

import {
  copyFileSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(repoRoot, "site");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  console.error(`Download site build failed: ${message}`);
  process.exit(1);
}

const outputRoot = resolve(argument("--output") ?? resolve(sourceRoot, "dist"));
// Resolve existing parent symlinks even when the output directory is new.
function actualPath(path) {
  const suffix = [];
  let parent = path;
  for (;;) {
    try {
      return resolve(realpathSync(parent), ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT" || dirname(parent) === parent) throw error;
      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

function containsPath(parent, path) {
  const child = relative(parent, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

const files = [
  ["site/model-catalog.json", "model-catalog.json"],
  ["site/assets/gyro-coast.webp", "assets/gyro-coast.webp"],
  ["site/_headers", "_headers"],
  ["site/robots.txt", "robots.txt"],
  ["site/sitemap.xml", "sitemap.xml"],
  ["site/index.html", "index.html"],
  ["site/install/index.html", "install/index.html"],
  ["site/changelog/index.html", "changelog/index.html"],
  ["site/privacy/index.html", "privacy/index.html"],
  ["site/styles.css", "styles.css"],
  ["site/app.js", "app.js"],
  ["site/agents.js", "agents.js"],
  ["site/theme.js", "theme.js"],
  ["site/changelog.js", "changelog.js"],
  ["site/release-utils.js", "release-utils.js"],
  ["site/assets/fonts/inter-latin.woff2", "assets/fonts/inter-latin.woff2"],
  [
    "site/assets/fonts/inter-tight-latin.woff2",
    "assets/fonts/inter-tight-latin.woff2",
  ],
  ["site/assets/gyro-logo.png", "assets/gyro-logo.png"],
  ["site/assets/gyro-mark.png", "assets/gyro-mark.png"],
  ["site/assets/agents/gemini-spark.png", "assets/agents/gemini-spark.png"],
  ["site/assets/apple.svg", "assets/apple.svg"],
  ["site/assets/github.svg", "assets/github.svg"],
  ["site/assets/ATTRIBUTIONS.md", "assets/ATTRIBUTIONS.md"],
  ["site/assets/social-preview.png", "assets/social-preview.png"],
  [
    "site/assets/screenshots/current-chat-light.webp",
    "assets/screenshots/current-chat-light.webp",
  ],
  [
    "site/assets/screenshots/current-chat-dark.webp",
    "assets/screenshots/current-chat-dark.webp",
  ],
  [
    "site/assets/screenshots/current-workspace-light.webp",
    "assets/screenshots/current-workspace-light.webp",
  ],
  [
    "site/assets/screenshots/current-workspace-dark.webp",
    "assets/screenshots/current-workspace-dark.webp",
  ],
  [
    "site/assets/screenshots/current-review-light.webp",
    "assets/screenshots/current-review-light.webp",
  ],
  [
    "site/assets/screenshots/current-review-dark.webp",
    "assets/screenshots/current-review-dark.webp",
  ],
];

// Reject destructive destinations before removing anything. Custom build
// directories remain supported, including new directories reached via symlinks.
try {
  const output = actualPath(outputRoot);
  const protectedPaths = [repoRoot, ...files.map(([source]) => resolve(repoRoot, source))];
  if (protectedPaths.some((path) => containsPath(output, actualPath(path)))) {
    fail("--output must not contain the repository or any site source file");
  }
} catch (error) {
  fail(`cannot validate --output: ${error.message}`);
}

for (const [source] of files) {
  const path = resolve(repoRoot, source);
  try {
    if (!statSync(path).isFile()) fail(`${source} is not a file`);
  } catch {
    fail(`required source file is missing: ${source}`);
  }
}

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(outputRoot, { recursive: true });

for (const [source, destination] of files) {
  const destinationPath = resolve(outputRoot, destination);
  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(resolve(repoRoot, source), destinationPath);
}

writeFileSync(resolve(outputRoot, ".nojekyll"), "", "utf8");
console.log(
  `Built dependency-free download site at ${relative(repoRoot, outputRoot) || outputRoot}`,
);
