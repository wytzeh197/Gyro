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
  existsSync(
    resolve(repoRoot, "packages/ui/src/assets/fonts/inter-latin.woff2"),
  ) &&
    existsSync(
      resolve(repoRoot, "packages/ui/src/assets/fonts/inter-tight-latin.woff2"),
    ) &&
    existsSync(
      resolve(repoRoot, "apps/desktop/public/fonts/inter-latin.woff2"),
    ) &&
    existsSync(
      resolve(repoRoot, "apps/desktop/public/fonts/inter-tight-latin.woff2"),
    ),
  "Inter and Inter Tight must be vendored for the desktop app and the UI package.",
);

expect(
  styles.includes('font-family: "Inter"') &&
    styles.includes('font-family: "Inter Tight"') &&
    styles.includes("--gyro-font-display") &&
    styles.includes("--gyro-font-sans") &&
    styles.includes('"cv05" 1') &&
    styles.includes('"cv11" 1'),
  "The app type ladder must load Inter / Inter Tight and enable Inter features.",
);

expect(
  earlyShell.includes('font-family: "Inter Tight"') &&
    earlyShell.includes("/fonts/inter-latin.woff2"),
  "First paint must load the same typefaces as the running app.",
);

expect(
  /^\s*--gyro-page-header-bg:\s*var\(--gyro-surface/.test(
    styles.match(/--gyro-page-header-bg:[^;]+/)?.[0] ?? "",
  ) && !/--gyro-page-header-bg:\s*linear-gradient/.test(styles),
  "Page headers must use a flat surface token, not a wash.",
);

expect(
  monaco.includes('defineTheme("gyro-dark"') &&
    monaco.includes('defineTheme("gyro-light"'),
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
