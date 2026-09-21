#!/usr/bin/env node
import {
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  statSync,
} from "node:fs";
import { dirname, resolve, relative, sep, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { pages } from "../site/content/pages.mjs";
import { layout } from "../site/templates/layout.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv.indexOf("--output");
const output = resolve(
  arg < 0 ? resolve(root, "site/dist") : process.argv[arg + 1],
);
// Never recursively remove a source directory or an ancestor of the checkout.
if (
  output !== resolve(root, "site/dist") &&
  (output === parse(output).root ||
    output === root ||
    root.startsWith(output + sep) ||
    output.startsWith(root + sep))
)
  throw new Error("Custom output must be outside the repository");
if (
  existsSync(output) &&
  (lstatSync(output).isSymbolicLink() ||
    (output !== resolve(root, "site/dist") && readdirSync(output).length))
) {
  throw new Error(
    "Refusing to replace a symlink or nonempty custom output directory",
  );
}
export const assets = [
  "_headers",
  "robots.txt",
  "styles.css",
  "theme.js",
  "app.js",
  "release-utils.js",
  "motion.js",
  "assets/fonts/inter-latin.woff2",
  "assets/fonts/inter-tight-latin.woff2",
  "assets/gyro-mark.png",
  ...["codex", "claude", "gemini", "grok", "kimi", "ollama"].map(
    (name) => `assets/providers/${name}.svg`,
  ),
  "assets/social-preview.png",
  "assets/ATTRIBUTIONS.md",
  "assets/gyro-coast.webp",
  "assets/screenshots/hero-current-light.webp",
  "assets/screenshots/hero-current-dark.webp",
  "assets/screenshots/hero-light-1200.webp",
  "assets/screenshots/hero-1200.webp",
  "assets/screenshots/hero-light-2400.webp",
  "assets/screenshots/hero-2400.webp",
  "assets/motion/workflow-light.mp4",
  "assets/motion/workflow-dark.mp4",
];
for (const asset of assets) {
  if (!statSync(resolve(root, "site", asset)).isFile())
    throw new Error(`Missing public asset: ${asset}`);
}
// Render before replacing the previous build; malformed content cannot erase it.
const rendered = pages.map((page) => [
  page.path === "/"
    ? "index.html"
    : page.path.endsWith(".html")
      ? page.path.slice(1)
      : page.path.slice(1) + "index.html",
  layout(page),
]);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const file of assets) {
  const dest = resolve(output, file);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(resolve(root, "site", file), dest);
}
for (const [file, html] of rendered) {
  const dest = resolve(output, file);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
}
// Public runtime gets only validated public release metadata, never source notes.
copyFileSync(
  resolve(root, "site/content/releases.json"),
  resolve(output, "releases.json"),
);
writeFileSync(
  resolve(output, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages
    .filter((p) => !p.noindex)
    .map((p) => `<url><loc>https://usegyro.io${p.path}</loc></url>`)
    .join("")}</urlset>\n`,
);
writeFileSync(resolve(output, ".nojekyll"), "");
console.log(`Built ${pages.length} pages at ${relative(root, output)}`);
