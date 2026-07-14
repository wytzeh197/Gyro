#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  console.error(`CLI release packaging failed: ${message}`);
  process.exit(1);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeString(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) {
    fail(`tar entry metadata is too long: ${value}`);
  }
  encoded.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeString(header, offset, length - 1, encoded);
  header[offset + length - 1] = 0;
}

function tarEntry(name, contents, mode) {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "wheel");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 6, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function buildArchive(binaryPath, version, target, outputDirectory) {
  if (!existsSync(binaryPath)) {
    fail(`binary does not exist at ${binaryPath}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`invalid version ${version}`);
  }
  if (!/^(?:aarch64|x86_64)-apple-darwin$/.test(target)) {
    fail(`unsupported release target ${target}`);
  }

  mkdirSync(outputDirectory, { recursive: true });
  const archiveName = `gyro-cli-${version}-${target}.tar.gz`;
  const archivePath = join(outputDirectory, archiveName);
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        schema: "gyro.cli.archive.v1",
        version,
        target,
        executable: "gyro",
      },
      null,
      2,
    )}\n`,
  );
  const entries = [
    ["gyro", readFileSync(binaryPath), 0o755],
    ["LICENSE", readFileSync(join(repoRoot, "LICENSE")), 0o644],
    ["README.md", readFileSync(join(repoRoot, "README.md")), 0o644],
    ["manifest.json", manifest, 0o644],
  ];
  const tar = Buffer.concat([
    ...entries.map(([name, contents, mode]) => tarEntry(name, contents, mode)),
    Buffer.alloc(1024),
  ]);
  const archive = gzipSync(tar, { level: 9, mtime: 0 });
  writeFileSync(archivePath, archive);
  const checksumPath = `${archivePath}.sha256`;
  writeFileSync(checksumPath, `${sha256(archive)}  ${archiveName}\n`);
  console.log(archivePath);
  console.log(checksumPath);
}

function parseTar(archive) {
  const tar = gunzipSync(archive);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/s, "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!name || !Number.isSafeInteger(size) || size < 0) {
      fail("archive contains an invalid tar header");
    }
    const contentsStart = offset + 512;
    const contentsEnd = contentsStart + size;
    if (contentsEnd > tar.length) fail(`archive entry ${name} is truncated`);
    if (entries.has(name)) fail(`archive contains duplicate entry ${name}`);
    entries.set(name, Buffer.from(tar.subarray(contentsStart, contentsEnd)));
    offset = contentsStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function runInstalledCli(entries, manifest) {
  const installRoot = mkdtempSync(join(tmpdir(), "gyro-cli-install-"));
  let failure;
  try {
    const binaryPath = join(installRoot, "bin", "gyro");
    const homePath = join(installRoot, "home");
    mkdirSync(dirname(binaryPath), { recursive: true });
    mkdirSync(homePath, { recursive: true });
    writeFileSync(binaryPath, entries.get("gyro"));
    chmodSync(binaryPath, 0o755);
    const environment = {
      ...process.env,
      HOME: homePath,
      NO_COLOR: "1",
      GYRO_DISABLE_APP_HANDOFF: "1",
    };
    for (const [label, args, validate] of [
      ["version", ["--version"], (output) => output.includes(manifest.version)],
      [
        "zsh completions",
        ["completions", "zsh"],
        (output) => output.includes("_gyro"),
      ],
      [
        "doctor",
        ["doctor", "--json"],
        (output) => {
          const parsed = JSON.parse(output);
          return (
            parsed.schema === "gyro.cli.v1" && Array.isArray(parsed.checks)
          );
        },
      ],
    ]) {
      const result = spawnSync(binaryPath, args, {
        encoding: "utf8",
        env: environment,
      });
      if (result.status !== 0) {
        throw new Error(
          `${label} check exited ${result.status}: ${(result.stderr || result.stdout).trim()}`,
        );
      }
      try {
        if (!validate(result.stdout)) throw new Error("output is invalid");
      } catch (error) {
        throw new Error(`${label} output is invalid: ${error.message}`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
  if (failure) fail(`installed CLI ${failure.message}`);
}

function verifyArchive(archivePath, checksumPath, runBinary) {
  const archive = readFileSync(archivePath);
  const checksumLine = readFileSync(checksumPath, "utf8").trim();
  const match = checksumLine.match(/^([a-f0-9]{64})  (\S+)$/);
  if (!match) fail(`invalid checksum file ${checksumPath}`);
  if (match[2] !== basename(archivePath)) {
    fail(`checksum names ${match[2]} instead of ${basename(archivePath)}`);
  }
  if (match[1] !== sha256(archive))
    fail(`checksum mismatch for ${archivePath}`);

  const entries = parseTar(archive);
  const expectedEntries = ["gyro", "LICENSE", "README.md", "manifest.json"];
  if (
    entries.size !== expectedEntries.length ||
    expectedEntries.some((name) => !entries.has(name))
  ) {
    fail(`archive entries must be exactly ${expectedEntries.join(", ")}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  } catch (error) {
    fail(`manifest.json is invalid: ${error.message}`);
  }
  if (
    manifest.schema !== "gyro.cli.archive.v1" ||
    manifest.executable !== "gyro" ||
    !basename(archivePath).includes(`-${manifest.version}-${manifest.target}.`)
  ) {
    fail("archive manifest does not match its filename or schema");
  }
  if (runBinary) runInstalledCli(entries, manifest);
  console.log(
    `Verified ${basename(archivePath)}${runBinary ? " and installed CLI" : ""}.`,
  );
}

if (process.argv.includes("--help")) {
  console.log(`Package a Gyro CLI release archive:
  node scripts/package-cli-release.mjs --binary <path> --version <version> --target <triple> [--output <directory>]

Verify an archive and optionally execute it from an isolated installation:
  node scripts/package-cli-release.mjs --verify <archive> [--checksum <sidecar>] [--run]`);
} else if (argument("--verify")) {
  const archiveToVerify = argument("--verify");
  const checksumPath = argument("--checksum") ?? `${archiveToVerify}.sha256`;
  verifyArchive(
    resolve(archiveToVerify),
    resolve(checksumPath),
    process.argv.includes("--run"),
  );
} else {
  const binary = argument("--binary");
  const version = argument("--version");
  const target = argument("--target");
  const output = argument("--output") ?? "release-assets";
  if (!binary || !version || !target) {
    fail(
      "use --binary <path> --version <version> --target <triple> [--output <directory>]",
    );
  }
  buildArchive(resolve(binary), version, target, resolve(output));
}
