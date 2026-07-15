#!/usr/bin/env node

import {
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
if (outputRoot === repoRoot || outputRoot === sourceRoot) {
  fail("--output must not be the repository root or site source directory");
}

const files = [
  ["site/index.html", "index.html"],
  ["site/install/index.html", "install/index.html"],
  ["site/changelog/index.html", "changelog/index.html"],
  ["site/privacy/index.html", "privacy/index.html"],
  ["site/styles.css", "styles.css"],
  ["site/app.js", "app.js"],
  ["site/changelog.js", "changelog.js"],
  ["site/release-utils.js", "release-utils.js"],
  ["site/assets/gyro-logo.png", "assets/gyro-logo.png"],
  ["site/assets/apple.svg", "assets/apple.svg"],
  ["site/assets/github.svg", "assets/github.svg"],
  ["site/assets/ATTRIBUTIONS.md", "assets/ATTRIBUTIONS.md"],
  ["site/assets/social-preview.png", "assets/social-preview.png"],
  [
    "site/assets/screenshots/hero-1512.webp",
    "assets/screenshots/hero-1512.webp",
  ],
  [
    "site/assets/screenshots/hero-3024.webp",
    "assets/screenshots/hero-3024.webp",
  ],
  [
    "site/assets/screenshots/hero-mobile-600.webp",
    "assets/screenshots/hero-mobile-600.webp",
  ],
  [
    "site/assets/screenshots/hero-mobile-1200.webp",
    "assets/screenshots/hero-mobile-1200.webp",
  ],
  ["site/assets/screenshots/chat-900.webp", "assets/screenshots/chat-900.webp"],
  [
    "site/assets/screenshots/chat-1800.webp",
    "assets/screenshots/chat-1800.webp",
  ],
  ["site/assets/screenshots/cli-800.webp", "assets/screenshots/cli-800.webp"],
  ["site/assets/screenshots/cli-1600.webp", "assets/screenshots/cli-1600.webp"],
  [
    "site/assets/screenshots/workspace-800.webp",
    "assets/screenshots/workspace-800.webp",
  ],
  [
    "site/assets/screenshots/workspace-1600.webp",
    "assets/screenshots/workspace-1600.webp",
  ],
];

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
