#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  console.error(`CLI release finalization failed: ${message}`);
  process.exit(1);
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const assetsDirectory = resolve(argument("--assets") ?? "release-assets");
const tag = argument("--tag");
if (!tag?.startsWith("v") || tag.length === 1)
  fail("--tag must be a v-prefixed version");
const version = tag.slice(1);
const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
const checksums = new Map();

for (const target of targets) {
  const archive = `gyro-cli-${version}-${target}.tar.gz`;
  const archivePath = join(assetsDirectory, archive);
  const sidecarPath = `${archivePath}.sha256`;
  let sidecar;
  try {
    sidecar = readFileSync(sidecarPath, "utf8").trim();
  } catch {
    fail(`missing checksum sidecar for ${archive}`);
  }
  const expected = `${digest(archivePath)}  ${archive}`;
  if (sidecar !== expected) fail(`checksum sidecar does not match ${archive}`);
  checksums.set(target, expected.slice(0, 64));
}

const checksumFiles = readdirSync(assetsDirectory)
  .filter(
    (name) =>
      !name.endsWith(".sha256") &&
      !name.endsWith(".sig") &&
      name !== "SHA256SUMS" &&
      name !== "latest.json" &&
      name !== "gyro.rb",
  )
  .sort();
writeFileSync(
  join(assetsDirectory, "SHA256SUMS"),
  checksumFiles
    .map((name) => `${digest(join(assetsDirectory, name))}  ${name}`)
    .join("\n") + "\n",
);

const repository = "https://github.com/wytzeh197/Gyro";
const formula = `class Gyro < Formula
  desc "Open-source local-first coding agent workspace CLI"
  homepage "${repository}"
  version "${version}"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "${repository}/releases/download/v#{version}/gyro-cli-#{version}-aarch64-apple-darwin.tar.gz"
      sha256 "${checksums.get("aarch64-apple-darwin")}"
    end

    on_intel do
      url "${repository}/releases/download/v#{version}/gyro-cli-#{version}-x86_64-apple-darwin.tar.gz"
      sha256 "${checksums.get("x86_64-apple-darwin")}"
    end
  end

  def install
    bin.install "gyro"
    generate_completions_from_executable(bin/"gyro", "completions")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/gyro --version")
    assert_match 'gyro.cli.v1', shell_output("#{bin}/gyro doctor --json")
  end
end
`;
writeFileSync(join(assetsDirectory, "gyro.rb"), formula);
console.log(`Created SHA256SUMS and gyro.rb for ${tag}.`);
