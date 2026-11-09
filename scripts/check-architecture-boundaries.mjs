import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const baseline = JSON.parse(
  await readFile(
    new URL("scripts/architecture-size-baseline.json", root),
    "utf8",
  ),
);

for (const [path, maximumLines] of Object.entries(baseline)) {
  const source = await readFile(new URL(path, root), "utf8");
  const lineCount = source.split("\n").length - 1;
  assert.ok(
    lineCount <= maximumLines,
    `${path} grew from its ${maximumLines}-line architecture ceiling to ${lineCount} lines; extract the new domain into a focused module`,
  );
}

// Desktop backend modules carved out of lib.rs used to open with
// `use super::*;`, which hands them every private item in the crate and makes
// the split cosmetic. Only the files below may still do that; a new module
// imports what it uses by name. Test modules (`tests.rs`, `*_tests.rs`, and
// indented `mod tests { use super::*; }` blocks) are exempt: that is ordinary
// Rust. When a listed file stops using the glob, drop it from the baseline so
// it cannot slide back.
const desktopSourceRoot = "apps/desktop/src-tauri/src";
const wildcardBaseline = new Set(
  JSON.parse(
    await readFile(
      new URL("scripts/architecture-wildcard-import-baseline.json", root),
      "utf8",
    ),
  ),
);
const wildcardImport = /^use (?:super|crate)::\*;/m;
const isTestModule = (path) => /(?:^|\/)(?:tests|[^/]+_tests)\.rs$/.test(path);
const desktopRustFiles = (
  await readdir(new URL(`${desktopSourceRoot}/`, root), { recursive: true })
)
  .filter((entry) => entry.endsWith(".rs"))
  .map((entry) => `${desktopSourceRoot}/${entry.split("\\").join("/")}`)
  .sort();
const wildcardFiles = new Set();
for (const path of desktopRustFiles) {
  if (isTestModule(path)) continue;
  const source = await readFile(new URL(path, root), "utf8");
  if (wildcardImport.test(source)) wildcardFiles.add(path);
}
const newWildcardFiles = [...wildcardFiles].filter(
  (path) => !wildcardBaseline.has(path),
);
assert.deepEqual(
  newWildcardFiles,
  [],
  `these desktop modules glob-import their parent (\`use super::*;\`); import the items they use by name instead:\n  ${newWildcardFiles.join("\n  ")}`,
);
const clearedWildcardFiles = [...wildcardBaseline].filter(
  (path) => !wildcardFiles.has(path),
);
assert.deepEqual(
  clearedWildcardFiles,
  [],
  `these files no longer glob-import their parent (or were moved); remove them from scripts/architecture-wildcard-import-baseline.json:\n  ${clearedWildcardFiles.join("\n  ")}`,
);

const coreCargo = await readFile(
  new URL("crates/gyro-core/Cargo.toml", root),
  "utf8",
);
assert.doesNotMatch(
  coreCargo,
  /^tauri(?:\s|=)/m,
  "gyro-core must remain independent of the Tauri desktop shell",
);

const uiFiles = [
  "packages/ui/src/index.ts",
  "packages/ui/src/provider-catalog.ts",
  "packages/ui/src/surfaces.tsx",
  "packages/ui/src/workspace-sidebar.tsx",
  "packages/ui/src/workbench-state.ts",
];
for (const path of uiFiles) {
  const source = await readFile(new URL(path, root), "utf8");
  assert.doesNotMatch(
    source,
    /from\s+["'](?:@tauri-apps|@anthropic-ai|openai|@agentclientprotocol)[^"']*["']/,
    `${path} must stay independent of desktop transport and provider-native SDKs`,
  );
}

console.log("architecture boundary checks passed");
