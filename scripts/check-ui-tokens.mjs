#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

const styles = read("packages/ui/src/styles.css");
const monaco = read("apps/desktop/src/monaco-editor.ts");
const earlyShell = read("apps/desktop/src/early-shell.css");

expect(
  /\.gyro-chat-start:not\(\.is-mission\)\s*\{[^}]*justify-content:\s*center;/.test(
    styles,
  ) &&
    /\.gyro-chat-start:not\(\.is-mission\)\s*>\s*\.gyro-composer-shell\s*\{[^}]*margin-top:\s*24px;/.test(
      styles,
    ),
  "Before the first message, the composer must stay with the centered quick actions, not bottom-dock.",
);

expect(
  styles.includes("--gyro-font-sans: -apple-system") &&
    /--gyro-font-display:\s*-apple-system/.test(styles) &&
    !styles.includes('font-family: "Inter"') &&
    !styles.includes('font-family: "Inter Tight"'),
  "App typography must use the macOS system stack, including companion layouts.",
);
expect(
  earlyShell.includes("font-family: -apple-system, BlinkMacSystemFont") &&
    !earlyShell.includes("@font-face"),
  "First paint must use the same system typeface as the running app.",
);

expect(
  /^\s*--gyro-page-header-bg:\s*var\(--gyro-surface/.test(
    styles.match(/--gyro-page-header-bg:[^;]+/)?.[0] ?? "",
  ) && !/--gyro-page-header-bg:\s*linear-gradient/.test(styles),
  "Page headers must use a flat surface token, not a wash.",
);

expect(
  monaco.includes('["dark", "light"] as const') &&
    monaco.includes("createMonacoTheme(mode)"),
  "Monaco must ship matching dark and light Gyro themes.",
);

const allowedGradient = [
  /transparent,\s*rgba\(0,\s*0,\s*0/,
  /transparent,\s*var\(--gyro-surface-raised\)/,
  /transparent,\s*rgba\(12,\s*14,\s*18/,
  /repeating-linear-gradient/,
  /45deg,\s*transparent 50%/,
  /135deg,/,
  /circle at \d+px \d+px/,
  // Theme picker thumbnails use solid tokens to preview hierarchy; these are
  // content samples, not decorative surface washes.
  /linear-gradient\(var\(--gyro-(?:surface-raised|border-strong|theme-preview-(?:dark|light)-(?:canvas|content))\) 0 0\)/,
  /linear-gradient\(\s*90deg,\s*var\(--gyro-theme-preview-dark-canvas\)/,
];

const styleLines = styles.split("\n");
const gradientLines = styleLines
  .map((line, index) => ({ line, n: index + 1 }))
  .filter(({ line }) => /(?:linear|radial)-gradient\s*\(/.test(line));

for (const { line, n } of gradientLines) {
  const window = styleLines.slice(n - 1, n + 4).join("\n");
  const allowed = allowedGradient.some((pattern) => pattern.test(window));
  expect(
    allowed,
    `Decorative gradient at packages/ui/src/styles.css:${n} is not on the content allowlist: ${line.trim()}`,
  );
}

if (failures.length > 0) {
  console.error(`check-ui-tokens failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("check-ui-tokens: ok");
