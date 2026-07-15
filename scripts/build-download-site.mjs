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
  ["site/styles.css", "styles.css"],
  ["site/app.js", "app.js"],
  ["apps/desktop/src-tauri/icons/icon.png", "assets/gyro-logo.png"],
  ["site/assets/apple.svg", "assets/apple.svg"],
  ["site/assets/github.svg", "assets/github.svg"],
  ["site/assets/ATTRIBUTIONS.md", "assets/ATTRIBUTIONS.md"],
  ["site/assets/hero-workbench.png", "assets/hero-workbench.png"],
  ["site/assets/chat-surface.png", "assets/chat-surface.png"],
  ["site/assets/cli-surface.png", "assets/cli-surface.png"],
  ["site/assets/workspace-surface.png", "assets/workspace-surface.png"],
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
