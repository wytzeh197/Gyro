#!/usr/bin/env node

// Regenerate every native icon from the shared vector mark:
//   node scripts/generate-native-icons.mjs
// Requires the workspace's local Tauri CLI and sharp. If sharp is supplied by
// an external tool runtime, set NODE_PATH to its node_modules directory.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require("sharp");
} catch (error) {
  throw new Error(
    "Native icon generation requires sharp. Install it locally or set NODE_PATH to a node_modules directory containing sharp.",
    { cause: error },
  );
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = resolve(repoRoot, "apps/desktop/src-tauri");
const iconsRoot = resolve(tauriRoot, "icons");
const menuBarRoot = resolve(iconsRoot, "menubar");
const source = await readFile(
  resolve(repoRoot, "packages/ui/src/assets/gyro-logo.svg"),
  "utf8",
);
const viewBox = source.match(/viewBox="([^"]+)"/)?.[1];
const paths = source.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/)?.[1];
if (!viewBox || !paths) {
  throw new Error("The canonical Gyro logo must be an SVG with a viewBox.");
}

function mark(x, y, size, ink) {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${viewBox}" fill="${ink}" color="${ink}">${paths.replaceAll("currentColor", ink).replaceAll("#111111", ink)}</svg>`;
}

// Preserve the existing inset macOS tile. The mark occupies approximately 60%
// of the tile width, keeping comfortable space around the new four-part shape.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="190" fill="#f8f8f6"/>
  ${mark(232, 232, 560, "#0a0a0a")}
</svg>`;
const appIconPath = resolve(tauriRoot, "app-icon.png");
await sharp(Buffer.from(appIcon)).png().toFile(appIconPath);

// Tauri produces macOS, Windows, Android, iOS and all existing PNG sizes from
// the same canonical 1024px source. Use the checked-in workspace CLI version.
const generated = spawnSync(
  "pnpm",
  [
    "--filter",
    "@gyro-dev/desktop",
    "exec",
    "tauri",
    "icon",
    appIconPath,
    "--output",
    iconsRoot,
  ],
  { cwd: repoRoot, stdio: "inherit" },
);
if (generated.error) throw generated.error;
if (generated.status !== 0) {
  throw new Error(`Tauri icon generation exited with ${generated.status}.`);
}

await mkdir(menuBarRoot, { recursive: true });

function menuBarIcon(indicator = "", angle = 0) {
  // Menu bar icons are 18pt at 2x. Black pixels plus alpha allow macOS to tint
  // template images for both menu bar appearances. The badge clears the mark
  // beneath it using transparency, so no white background enters the template.
  const mask = indicator
    ? `<defs><mask id="status-cutout" maskUnits="userSpaceOnUse" x="0" y="0" width="36" height="36"><rect width="36" height="36" fill="white"/><circle cx="28" cy="28" r="8" fill="black"/></mask></defs>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
  ${mask}
  <g${indicator ? ' mask="url(#status-cutout)"' : ""}><g transform="rotate(${angle} 18 18)">${mark(3, 3, 30, "#000")}</g></g>
  ${indicator}
</svg>\n`;
}

const indicators = {
  working:
    '<circle cx="28" cy="28" r="3.2" fill="none" stroke="#000" stroke-width="2.4"/>',
  attention:
    '<path d="M28 22.4v5.8" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round"/><circle cx="28" cy="31.6" r="1.3" fill="#000"/>',
  complete:
    '<path d="m22.5 27.5 3.8 3.8 6.2-7.5" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
};
const menuBarIcons = [
  ["gyro-idle", menuBarIcon()],
  ["gyro-attention", menuBarIcon(indicators.attention)],
  ["gyro-complete", menuBarIcon(indicators.complete)],
  ...[-12, -7, -2, 3, 8, 13].map((angle, index) => [
    `gyro-working-${index}`,
    menuBarIcon(indicators.working, angle),
  ]),
];
for (const [name, svg] of menuBarIcons) {
  await writeFile(resolve(menuBarRoot, `${name}.svg`), svg);
  await sharp(Buffer.from(svg))
    .png()
    .toFile(resolve(menuBarRoot, `${name}.png`));
}

console.log("Generated Gyro native app icons and all nine menu bar states.");
