import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { languageDefinitions } from "../packages/ui/src/editor/languages/definitions.ts";

const root = new URL("../", import.meta.url);
const rust = await readFile(
  new URL("apps/desktop/src-tauri/src/language_server.rs", root),
  "utf8",
);

// The editor's registry is executed here, not pattern-matched: the module
// merges its enhancements table into languageDefinitions at import time, so
// reading the live definitions is what the editor actually ships. Only the
// entries that name an lsp command participate in this contract.
const uiPairs = new Set();
for (const definition of languageDefinitions) {
  if (!definition.lsp) continue;
  uiPairs.add(
    `${definition.lsp.languageId ?? definition.id}\u0000${definition.lsp.command}`,
  );
}
assert.ok(uiPairs.size > 0, "definitions.ts no longer declares any lsp command");

// Rust owns what the capabilities may start, so both of its tables must agree
// with the editor list. The crate cannot be executed from Node, so the Rust
// side stays extracted from source.
const rustPairs = new Set();
for (const table of rust.matchAll(
  /const LANGUAGE_SERVER_BY_(?:SUFFIX|FILENAME)[^=]*= &\[([\s\S]*?)\];/g,
)) {
  for (const entry of table[1].matchAll(
    // rustfmt reflows a long tuple across lines and leaves a trailing comma,
    // so accept both the compact and the expanded shape.
    /\(\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\s*,?\s*\)/g,
  )) {
    rustPairs.add(`${entry[2]}\u0000${entry[3]}`);
  }
}
assert.ok(
  rustPairs.size > 0,
  "language_server.rs no longer declares a language-server table",
);

const sorted = (set) => [...set].sort();
assert.deepEqual(
  sorted(rustPairs),
  sorted(uiPairs),
  "language_server.rs and definitions.ts disagree about (language id, command) pairs; update both",
);

// Every entry the file-type table can return must also survive the allowlist
// that guards spawning.
for (const pair of rustPairs) {
  const [languageId, command] = pair.split("\u0000");
  assert.ok(
    rust.includes(`"${languageId}"`) && rust.includes(`"${command}"`),
    `the command allowlist no longer covers ${languageId} / ${command}`,
  );
}

console.log("language server registry checks passed");
