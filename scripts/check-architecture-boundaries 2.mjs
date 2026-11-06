import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
