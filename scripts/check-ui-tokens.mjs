#!/usr/bin/env node
import { postcss } from "./css-parser.mjs";
import { readUiStyleSources } from "./ui-style-sources.mjs";
import { checkChatStyles } from "./check-chat-styles.mjs";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [...checkChatStyles()];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

const styleFiles = readUiStyleSources();
const styles = styleFiles.map(({ source }) => source).join("\n");

// Line n of the joined `styles` text, as the file and line it came from.
function styleLocation(n) {
  let first = 1;
  for (const { path, source } of styleFiles) {
    const lines = source.split("\n").length;
    if (n < first + lines) return `${path}:${n - first + 1}`;
    first += lines;
  }
  return `styles:${n}`;
}
const monaco = read("apps/desktop/src/monaco-editor.ts");
const earlyShell = read("apps/desktop/src/early-shell.css");
const brand = read("packages/ui/src/brand.css");

expect(
  /\.gyro-chat-surface\.is-empty\s*>\s*\.gyro-chat-start:not\(\.is-mission\)\s*\{[^}]*justify-content:\s*flex-end;/.test(
    styles,
  ) &&
    /\.gyro-composer-shell\s*>\s*\.gyro-composer-context-row\s*\{[^}]*justify-content:\s*flex-start;/.test(
      styles,
    ),
  "New chats must dock the composer at the bottom with workspace context above it on the left.",
);

expect(
  /--gyro-font-sans:\s*"Geist", -apple-system/.test(styles) &&
    /--gyro-font-display:\s*"Geist", -apple-system/.test(styles) &&
    /--gyro-font-mono:\s*"Geist Mono", ui-monospace/.test(styles) &&
    brand.includes('font-family: "Geist"') &&
    brand.includes('font-family: "Geist Mono"') &&
    ["geist-latin.woff2", "geist-mono-latin.woff2"].every(
      (font) =>
        brand.includes(`./assets/fonts/${font}`) &&
        existsSync(resolve(repoRoot, "packages/ui/src/assets/fonts", font)),
    ) &&
    !styles.includes('font-family: "Inter"') &&
    !styles.includes('font-family: "Inter Tight"'),
  "App typography must use the bundled Geist faces with system fallbacks, including companion layouts.",
);
expect(
  earlyShell.includes("font-family: -apple-system, BlinkMacSystemFont") &&
    !earlyShell.includes("@font-face"),
  "First paint must use the system fallback without waiting for a font load.",
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

// --gyro-warning was never defined, so five call sites silently rendered a
// hardcoded amber that never responded to the light theme. The real token is
// --gyro-warn; keep the typo unrepresentable.
expect(
  !/var\(\s*--gyro-warning[),]|--gyro-warning\s*:/.test(
    styles.replace(/\/\*[\s\S]*?\*\//g, ""),
  ),
  "Agent-state amber is --gyro-warn. --gyro-warning is undefined and has no light-theme value.",
);

const lightThemeBlock = styles.match(
  /:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/,
)?.[0];
expect(
  Boolean(lightThemeBlock) &&
    ["running", "waiting", "success", "warning", "failed"].every((state) =>
      lightThemeBlock.includes(`--gyro-status-${state}:`),
    ),
  "Every agent state that carries meaning needs a light-theme value; the dark ramp drops to roughly 2:1 on white.",
);

const allowedGradient = [
  /transparent,\s*rgba\(0,\s*0,\s*0/,
  /transparent,\s*var\(--gyro-surface-raised\)/,
  /transparent,\s*rgba\(12,\s*14,\s*18/,
  /repeating-linear-gradient/,
  /45deg,\s*transparent 50%/,
  /135deg,/,
  /circle at \d+px \d+px/,
  // The Workspace sidebar's rounded top-left corner is geometry, not a wash:
  // the gradient cuts the panel arc out of the chrome band and strokes it with
  // the same seam token the rail divider below it uses.
  /circle at var\(--gyro-workspace-panel-radius\)/,
  // Theme picker thumbnails use solid tokens to preview hierarchy; these are
  // content samples, not decorative surface washes.
  /linear-gradient\(var\(--gyro-(?:surface-raised|border-strong|theme-preview-(?:dark|light)-(?:canvas|content))\) 0 0\)/,
  /linear-gradient\(\s*90deg,\s*var\(--gyro-theme-preview-dark-canvas\)/, // The thread composer's scrim fades messages out above the dock; it covers
  // content with the canvas colour rather than tinting a surface.
  /transparent 0%,\s*var\(--gyro-composer-scrim\)/,
  // Media captions and the transcript dock fade content rather than paint a wash.
  /transparent,\s*color-mix\(in srgb, var\(--gyro-chat-(?:media-shade|raised)\)/,
];

// Parse declarations so continuation lines of geometry masks remain masks,
// and moving a rule never changes which source file the check understands.
for (const { path, source } of styleFiles) {
  postcss.parse(source, { from: path }).walkDecls((declaration) => {
    if (!/(?:linear|radial)-gradient\s*\(/.test(declaration.value)) return;
    if (/^(?:-webkit-)?mask(?:-image)?$/.test(declaration.prop)) return;
    const selector =
      declaration.parent.selector?.replace(/\s+/g, " ").trim() ?? "";
    const isEffortIndicator =
      selector === ".gyro-effort-slider-fill" ||
      /^\.gyro-effort-slider-popover\[data-max-effort="true"\]\s+\.gyro-effort-slider-(?:fill|track::after)$/.test(
        selector,
      );
    const isStartBeam =
      /\.gyro-chat-surface\.is-empty/.test(selector) &&
      /var\(--gyro-beam-drift\)/.test(declaration.value);
    expect(
      isEffortIndicator ||
        isStartBeam ||
        allowedGradient.some((pattern) => pattern.test(declaration.value)),
      `Decorative gradient at ${path}:${declaration.source.start.line} is not on the content allowlist: ${declaration.value}`,
    );
  });
}

// Design-drift budget. Every Gyro stylesheet is counted, so moving rules
// between files cannot hide them. A count may fall but never rise: lower
// scripts/ui-token-budget.json with --update-budget once a cleanup lands.
const budgetPath = resolve(repoRoot, "scripts/ui-token-budget.json");
const allStyles = styleFiles
  .map(({ source }) => source)
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const declarations = [
  ...allStyles.matchAll(/([a-z-]+)\s*:\s*([^;{}]+?)\s*(?=;|\})/g),
].map(([, property, value]) => ({
  property,
  value: value.replace(/\s*!important$/, "").replace(/\s+/g, " "),
}));
const literalDeclarations = declarations.filter(
  ({ property }) => !property.startsWith("--"),
);
const distinct = (property) =>
  new Set(
    literalDeclarations
      // Reusing an existing semantic token is not a new literal design value.
      // Compound values and fallbacks still count, so raw geometry cannot hide
      // inside calc() or var(--token, 13px).
      .filter(
        (declaration) =>
          declaration.property === property &&
          !/^var\(--gyro-[a-z0-9-]+\)$/.test(declaration.value),
      )
      .map(({ value }) => value),
  ).size;
const count = (pattern) =>
  literalDeclarations.filter(({ value }) => pattern.test(value)).length;
const measured = {
  important: (allStyles.match(/!important/g) ?? []).length,
  lightThemeSelectors: (allStyles.match(/\[data-theme="light"\]/g) ?? [])
    .length,
  hexLiterals: count(/#[0-9a-f]{3,8}\b/i),
  rgbLiterals: count(/\brgba?\(\s*\d/),
  tokenLiteralFallbacks: (
    allStyles.match(
      /var\(--gyro-[a-z0-9-]+,\s*(?:#|rgb|\d[\d.]*(?:px|%|r?em|m?s)\b)/g,
    ) ?? []
  ).length,
  pillRadiusLiterals: count(/^9{3,}px$/),
  fontSizeValues: distinct("font-size"),
  fontWeightValues: distinct("font-weight"),
  radiusValues: distinct("border-radius"),
  zIndexValues: distinct("z-index"),
  letterSpacingValues: distinct("letter-spacing"),
};
if (process.argv.includes("--update-budget")) {
  writeFileSync(budgetPath, `${JSON.stringify(measured, null, 2)}\n`);
  console.log(`check-ui-tokens: budget written to ${budgetPath}`);
} else {
  const budget = existsSync(budgetPath)
    ? JSON.parse(readFileSync(budgetPath, "utf8"))
    : {};
  for (const [metric, value] of Object.entries(measured)) {
    const ceiling = budget[metric];
    expect(
      ceiling !== undefined && value <= ceiling,
      ceiling === undefined
        ? `Design budget has no entry for ${metric} (${value}); run with --update-budget.`
        : `Design budget ${metric} rose from ${ceiling} to ${value}; use the existing token instead of a new literal or override.`,
    );
    if (ceiling !== undefined && value < ceiling) {
      console.log(
        `check-ui-tokens: ${metric} fell from ${ceiling} to ${value}; lower the budget with --update-budget.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`check-ui-tokens failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("check-ui-tokens: ok");
