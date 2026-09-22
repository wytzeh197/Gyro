#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const buildSource = readFileSync(new URL("./build-download-site.mjs", import.meta.url), "utf8");
const sourceFiles = [...buildSource.matchAll(/\[\s*"(site\/[^"]+)",\s*"[^"]+",?\s*\]/g)]
  .map((match) => match[1]);
assert.ok(sourceFiles.length > 20, "Build safety fixture must include the site's actual source list");
const root = mkdtempSync(join(tmpdir(), "gyro-site-build-safety-"));
const repo = join(root, "project");
const script = join(repo, "scripts/build-download-site.mjs");
const sentinel = join(root, "keep.txt");

try {
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, buildSource);
  writeFileSync(sentinel, "preserve");
  for (const source of sourceFiles) {
    const path = join(repo, source);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  symlinkSync(repo, join(root, "repo-link"), "dir");
  symlinkSync(join(repo, "site/assets"), join(root, "assets-link"), "dir");
  const build = (output) => spawnSync(process.execPath, [script, "--output", output], {
    encoding: "utf8",
    timeout: 10000,
  });

  for (const output of [
    root,
    repo,
    join(repo, "site"),
    join(repo, "site/assets"),
    join(repo, "site/index.html"),
    join(root, "repo-link"),
    join(root, "repo-link/site"),
    join(root, "assets-link"),
  ]) {
    const result = build(output);
    assert.equal(result.status, 1, output);
    assert.match(result.stderr, /--output must not contain/, output);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve", output);
    assert.ok(existsSync(script), "Rejected outputs must not remove repository files");
    assert.equal(readFileSync(join(repo, "site/index.html"), "utf8"), "site/index.html");
  }

  // A sibling whose name starts with "site" is safe; containment is path-based.
  const output = join(repo, "site-build");
  for (let pass = 0; pass < 2; pass++) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "stale.txt"), "replace this old build");
    const result = build(output);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(output, "index.html"), "utf8"), "site/index.html");
    assert.equal(existsSync(join(output, "stale.txt")), false);
  }

  // Resolve a new destination through an existing parent symlink safely.
  const external = join(root, "output-parent");
  mkdirSync(external);
  symlinkSync(external, join(root, "output-link"), "dir");
  const result = build(join(root, "output-link/new/dist"));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(external, "new/dist/index.html")));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Download site build safety checks passed.");
