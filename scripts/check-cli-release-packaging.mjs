#!/usr/bin/env node

import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
).version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${basename(command)} ${args.join(" ")} failed:\n${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

const rustc = run("rustc", ["-vV"]).stdout;
const target = rustc.match(/^host: (.+)$/m)?.[1];
if (!/^(?:aarch64|x86_64)-apple-darwin$/.test(target ?? "")) {
  throw new Error(
    `CLI packaging smoke requires a native macOS Rust target, got ${target}`,
  );
}

const binary = resolve(process.argv[2] ?? join(repoRoot, "target/debug/gyro"));
const first = mkdtempSync(join(tmpdir(), "gyro-cli-release-first-"));
const second = mkdtempSync(join(tmpdir(), "gyro-cli-release-second-"));
const corrupt = mkdtempSync(join(tmpdir(), "gyro-cli-release-corrupt-"));

try {
  const packageArgs = [
    "scripts/package-cli-release.mjs",
    "--binary",
    binary,
    "--version",
    version,
    "--target",
    target,
  ];
  run(process.execPath, [...packageArgs, "--output", first]);
  run(process.execPath, [...packageArgs, "--output", second]);

  const archiveName = `gyro-cli-${version}-${target}.tar.gz`;
  const firstArchive = join(first, archiveName);
  const secondArchive = join(second, archiveName);
  if (!readFileSync(firstArchive).equals(readFileSync(secondArchive))) {
    throw new Error(
      "identical CLI inputs did not produce an identical archive",
    );
  }
  run(process.execPath, [
    "scripts/package-cli-release.mjs",
    "--verify",
    firstArchive,
    "--run",
  ]);

  const corruptArchive = join(corrupt, archiveName);
  copyFileSync(firstArchive, corruptArchive);
  copyFileSync(`${firstArchive}.sha256`, `${corruptArchive}.sha256`);
  appendFileSync(corruptArchive, "tampered");
  const rejected = spawnSync(
    process.execPath,
    ["scripts/package-cli-release.mjs", "--verify", corruptArchive],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (rejected.status === 0 || !rejected.stderr.includes("checksum mismatch")) {
    throw new Error(
      "tampered CLI archive was not rejected as a checksum mismatch",
    );
  }

  const otherTarget =
    target === "aarch64-apple-darwin"
      ? "x86_64-apple-darwin"
      : "aarch64-apple-darwin";
  run(process.execPath, [
    ...packageArgs.slice(0, -1),
    otherTarget,
    "--output",
    first,
  ]);
  run(process.execPath, [
    "scripts/finalize-cli-release.mjs",
    "--assets",
    first,
    "--tag",
    `v${version}`,
  ]);
  const formula = readFileSync(join(first, "gyro.rb"), "utf8");
  const sums = readFileSync(join(first, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n");
  if (formula.includes("REPLACE_WITH") || sums.length !== 2) {
    throw new Error(
      "release finalization did not produce two real CLI checksums",
    );
  }

  console.log(
    `CLI release packaging smoke passed for ${version} on ${target}.`,
  );
} finally {
  for (const directory of [first, second, corrupt]) {
    rmSync(directory, { recursive: true, force: true });
  }
}
