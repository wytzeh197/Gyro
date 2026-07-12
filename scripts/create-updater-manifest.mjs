#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const assetsDirectory = resolve(argument("--assets") ?? "release-assets");
const tag = argument("--tag") ?? process.env.GITHUB_REF_NAME;

if (!tag?.startsWith("v") || tag.length === 1) {
  throw new Error("Provide a version tag such as v0.1.0-alpha.7 with --tag.");
}

if (!existsSync(assetsDirectory)) {
  throw new Error(`Release asset directory does not exist: ${assetsDirectory}`);
}

const assets = readdirSync(assetsDirectory);

function uniqueAsset(pattern, label) {
  const matches = assets.filter((asset) => pattern.test(asset));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${label} in ${assetsDirectory}, found ${matches.length}: ${matches.join(", ") || "none"}`,
    );
  }
  return matches[0];
}

function platform(archivePattern, label) {
  const archive = uniqueAsset(archivePattern, `${label} updater archive`);
  const signatureName = `${archive}.sig`;
  const signaturePath = resolve(assetsDirectory, signatureName);
  if (!existsSync(signaturePath)) {
    throw new Error(`Missing ${label} updater signature: ${signatureName}`);
  }
  const signature = readFileSync(signaturePath, "utf8").trim();
  if (!signature) {
    throw new Error(`${label} updater signature is empty: ${signatureName}`);
  }
  return {
    signature,
    url: `https://github.com/wytzeh197/Gyro/releases/download/${tag}/${archive}`,
  };
}

uniqueAsset(/_aarch64\.dmg$/, "Apple Silicon DMG");
uniqueAsset(/_x64\.dmg$/, "Intel DMG");

const appleSilicon = platform(/_aarch64\.app\.tar\.gz$/, "Apple Silicon");
const intel = platform(/_x64\.app\.tar\.gz$/, "Intel");
const manifest = {
  version: tag.slice(1),
  notes: "Signed macOS private preview for Apple Silicon and Intel.",
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": appleSilicon,
    "darwin-aarch64-app": appleSilicon,
    "darwin-x86_64": intel,
    "darwin-x86_64-app": intel,
  },
};

const outputPath = resolve(assetsDirectory, "latest.json");
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Created ${basename(outputPath)} for ${manifest.version} with ${Object.keys(manifest.platforms).length} platform entries.`,
);
