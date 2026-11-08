// Local provenance only. This module never launches a model or reads credentials.
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export async function captureRunSources(root = resolve(".")) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  // Hash build inputs and harness code, including untracked additions. Content
  // and environment values are never copied into the manifest.
  const paths = [...new Set(git([
    "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
    "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo",
    "crates", "apps/desktop/src-tauri", "catalog", "config",
    "scripts", "docs/performance/efficiency-pilot.json",
    "docs/performance/efficiency-repo-pilot.json",
  ]).toString("utf8").split("\0").filter(Boolean))].sort();
  const files = [];
  for (const path of paths) {
    try {
      const bytes = await readFile(join(root, path));
      files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    } catch (error) {
      // A tracked deletion is also a reproducible input state.
      if (error.code !== "ENOENT") throw error;
      files.push({ path, deleted: true });
    }
  }
  return {
    revision: git(["rev-parse", "HEAD"]).toString("utf8").trim(),
    sourceSnapshot: "sha256:" + sha256(JSON.stringify(files)),
    files,
  };
}

export function assertSameSources(before, after) {
  if (before.revision !== after.revision ||
      before.sourceSnapshot !== after.sourceSnapshot)
    throw Error("Benchmark source inputs changed; rebuild before running comparisons");
}

export async function captureRunManifest(sources, binaryPath, spec, built) {
  const binaryHash = createHash("sha256");
  for await (const chunk of createReadStream(binaryPath)) binaryHash.update(chunk);
  return {
    schema: "gyro.efficiency-run-manifest.v1",
    capturedAt: new Date().toISOString(),
    ...sources,
    specSha256: sha256(JSON.stringify(spec)),
    binarySha256: binaryHash.digest("hex"),
    buildCoverage: built ? "built-from-captured-inputs" : "unverified-skip-build",
    runtime: {
      node: process.version,
      rustc: execFileSync("rustc", ["--version"]).toString("utf8").trim(),
      platform: process.platform,
      arch: process.arch,
    },
  };
}
