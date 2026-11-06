/**
 * Run-rail capability coverage.
 *
 * `crates/gyro-core/src/capabilities.rs` decides which capabilities exist; the
 * table in `packages/ui/src/capability-ui.ts` decides what each one is called
 * and which row (and so which icon) it becomes. When the two drift, the rail
 * quietly degrades to a humanized id and a wrench — the bug this file catches
 * before it ships.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_UI,
  capabilityIdFromToolName,
  capabilityLabel,
} from "../packages/ui/src/capability-ui.ts";
import { browserCapabilityText } from "../packages/ui/src/chat-run.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  join(root, "crates/gyro-core/src/capabilities.rs"),
  "utf8",
);

const enumBody = source.match(/pub enum CapabilityId \{([\s\S]*?)\n\}/);
assert.ok(enumBody, "CapabilityId enum not found in capabilities.rs");

/** `CodeModeDiscover` → `code-mode-discover`, the id a capability call carries. */
const kebab = (name) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const backendIds = [
  ...enumBody[1].matchAll(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/gm),
].map((match) => kebab(match[1]));
assert.ok(
  backendIds.length >= 60,
  `parsed only ${backendIds.length} capability ids from the Rust enum`,
);

const uiIds = Object.keys(CAPABILITY_UI);
assert.deepEqual(
  backendIds.filter((id) => !(id in CAPABILITY_UI)),
  [],
  "capabilities the rail has no entry for",
);
assert.deepEqual(
  uiIds.filter((id) => !backendIds.includes(id)),
  [],
  "rail entries the backend does not declare",
);

for (const [id, ui] of Object.entries(CAPABILITY_UI)) {
  assert.ok(ui.label.trim(), `${id} has no title`);
  assert.match(ui.label, /^[A-Z]/, `${id} title must start capitalised`);
  assert.ok(
    !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(ui.label),
    `${id} title reads like an id`,
  );
  if (ui.row === "browser") {
    assert.ok(ui.action, `${id} is a browser row with no verb`);
    const running = browserCapabilityText(id, "running");
    const done = browserCapabilityText(id, "completed");
    assert.ok(running.label && done.label, `${id} has no browser wording`);
    assert.notEqual(
      running.label,
      done.label,
      `${id} reads the same while running`,
    );
  }
}

// Ids that used to fall through to "Github …" and "Inspecting browser".
assert.equal(capabilityLabel("github-push"), "Push branch");
assert.equal(capabilityLabel("browser-viewport"), "Resize viewport");
assert.equal(capabilityLabel("workspace-create-path"), "Create path");

// Provider tool names resolve to the ids the capability events carry.
assert.equal(capabilityIdFromToolName("gyro_workspace_read"), "workspace-read");
assert.equal(
  capabilityIdFromToolName("mcp__gyro_capabilities__gyro_workspace_list"),
  "workspace-list",
);
assert.equal(capabilityIdFromToolName("Bash"), undefined);

console.log(
  `capability labels: ${backendIds.length} capabilities, ${uiIds.length} rail entries`,
);
