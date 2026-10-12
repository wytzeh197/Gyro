#!/usr/bin/env node

// Render the frontend's compatibility PNGs from the canonical vector.
// Requires sharp (install locally or expose it through NODE_PATH).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = "packages/ui/src/assets";
const source = readFileSync(resolve(root, assets, "gyro-logo.svg"), "utf8");
const white = source.replaceAll('fill="#111111"', 'fill="#fafaf8"');
if (white === source)
  throw new Error("The canonical logo must use #111111 ink.");
writeFileSync(resolve(root, assets, "gyro-logo-white.svg"), white);

function tile(mark, background, rounded = false) {
  const nested = mark.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\s(?:width|height)="[^"]*"/g, "")
      .replace(">", ' x="162" y="162" width="700" height="700">'),
  );
  const backdrop = rounded
    ? `<rect x="100" y="100" width="824" height="824" rx="180" fill="${background}"/>`
    : `<rect width="1024" height="1024" fill="${background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${backdrop}${nested}</svg>`;
}

const lightTile = tile(source, "#fafaf8");
const darkTile = tile(white, "#0a0a0a");
const appTile = tile(source, "#f7f7f5", true);
const outputs = [
  [`${assets}/gyro-logo-transparent-dark.png`, source, 603],
  [`${assets}/gyro-logo-transparent.png`, white, 603],
  [`${assets}/gyro-logo-mark.png`, lightTile, 1024],
  [`${assets}/gyro-logo-light.png`, lightTile, 1024],
  [`${assets}/gyro-logo-dark.png`, darkTile, 1024],
  ["apps/desktop/public/gyro-logo.png", appTile, 512],
  ["site/assets/gyro-logo.png", appTile, 512],
  ["site/assets/gyro-mark.png", white, 603],
];

for (const [path, svg, size] of outputs) {
  await sharp(Buffer.from(svg), { density: 192 })
    .resize(size, size)
    .png()
    .toFile(resolve(root, path));
  console.log(`Rendered ${path}`);
}
