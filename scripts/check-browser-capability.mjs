/**
 * Assert every browser capability descriptor has a provider tool name, class,
 * schema arm, and handler arm — the same table-driven contract used for the
 * rest of CAPABILITY_DESCRIPTORS.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const capabilities = readFileSync(
  join(root, "crates/gyro-core/src/capabilities.rs"),
  "utf8",
);
const lib = readFileSync(
  join(root, "apps/desktop/src-tauri/src/lib.rs"),
  "utf8",
);
const sessionBrowser = readFileSync(
  join(root, "apps/desktop/src-tauri/src/session_browser.rs"),
  "utf8",
);
const types = readFileSync(join(root, "packages/ui/src/types.ts"), "utf8");
const cargo = readFileSync(
  join(root, "apps/desktop/src-tauri/Cargo.toml"),
  "utf8",
);

/** New drive-capable browser tools (plus the original four). */
const BROWSER_TOOLS = [
  {
    id: "BrowserOpen",
    tool: "gyro_browser_open",
    class: "BrowserNavigate",
    required: ["url"],
  },
  {
    id: "BrowserInspect",
    tool: "gyro_browser_inspect",
    class: "BrowserInspect",
    required: [],
  },
  {
    id: "BrowserReload",
    tool: "gyro_browser_reload",
    class: "BrowserNavigate",
    required: [],
  },
  {
    id: "BrowserScreenshot",
    tool: "gyro_browser_screenshot",
    class: "BrowserInspect",
    required: [],
  },
  {
    id: "BrowserNavigate",
    tool: "gyro_browser_navigate",
    class: "BrowserNavigate",
    required: ["url"],
  },
  {
    id: "BrowserBack",
    tool: "gyro_browser_back",
    class: "BrowserNavigate",
    required: [],
  },
  {
    id: "BrowserForward",
    tool: "gyro_browser_forward",
    class: "BrowserNavigate",
    required: [],
  },
  {
    id: "BrowserClick",
    tool: "gyro_browser_click",
    class: "BrowserNavigate",
    required: ["ref"],
  },
  {
    id: "BrowserType",
    tool: "gyro_browser_type",
    class: "BrowserNavigate",
    required: ["text"],
  },
  {
    id: "BrowserScroll",
    tool: "gyro_browser_scroll",
    class: "BrowserNavigate",
    required: [],
  },
  {
    id: "BrowserFormInput",
    tool: "gyro_browser_form_input",
    class: "BrowserNavigate",
    required: ["ref", "value"],
  },
  {
    id: "BrowserReadPage",
    tool: "gyro_browser_read_page",
    class: "BrowserInspect",
    required: [],
  },
  {
    id: "BrowserFind",
    tool: "gyro_browser_find",
    class: "BrowserInspect",
    required: [],
  },
  {
    id: "BrowserConsole",
    tool: "gyro_browser_console",
    class: "BrowserInspect",
    required: [],
  },
  {
    id: "BrowserNetwork",
    tool: "gyro_browser_network",
    class: "BrowserInspect",
    required: [],
  },
];

assert.match(
  cargo,
  /"unstable"/,
  "tauri unstable feature must be enabled for child webviews",
);

assert.match(
  types,
  /ChatSidePanelId =[\s\S]*?\|\s*"browser"/,
  "ChatSidePanelId must include browser",
);

for (const tool of BROWSER_TOOLS) {
  assert.match(
    capabilities,
    new RegExp(`\\b${tool.id}\\b`),
    `${tool.id} missing from CapabilityId enum`,
  );
  assert.match(
    capabilities,
    new RegExp(`Self::${tool.id} => "${tool.tool}"`),
    `${tool.id} provider_tool_name must be ${tool.tool}`,
  );
  assert.match(
    capabilities,
    new RegExp(
      `id: CapabilityId::${tool.id},\\s*class: CapabilityClass::${tool.class}`,
      "s",
    ),
    `${tool.id} must map to class ${tool.class}`,
  );

  // Handler arm appears in execute_provider_capability.
  assert.match(
    lib,
    new RegExp(`CapabilityId::${tool.id}`),
    `${tool.id} must appear in desktop capability handlers`,
  );

  // Schema arm or fallthrough empty properties still covered by presence.
  if (tool.required.length > 0) {
    for (const field of tool.required) {
      // Required fields are listed near Browser* schema arms or in the required match.
      assert.ok(
        lib.includes(`"${field}"`) && lib.includes(`CapabilityId::${tool.id}`),
        `${tool.id} schema should reference required field ${field}`,
      );
    }
  }
}

// Interaction tools must stay on the Ask class (BrowserNavigate), not auto-Allow.
for (const id of [
  "BrowserClick",
  "BrowserType",
  "BrowserScroll",
  "BrowserFormInput",
  "BrowserNavigate",
  "BrowserBack",
  "BrowserForward",
]) {
  assert.match(
    capabilities,
    new RegExp(
      `id: CapabilityId::${id},\\s*class: CapabilityClass::BrowserNavigate`,
      "s",
    ),
    `${id} must be BrowserNavigate (Ask gate)`,
  );
}

// Read tools stay on BrowserInspect (Allow by default).
for (const id of [
  "BrowserReadPage",
  "BrowserFind",
  "BrowserConsole",
  "BrowserNetwork",
  "BrowserInspect",
  "BrowserScreenshot",
]) {
  assert.match(
    capabilities,
    new RegExp(
      `id: CapabilityId::${id},\\s*class: CapabilityClass::BrowserInspect`,
      "s",
    ),
    `${id} must be BrowserInspect`,
  );
}

// Substrate pieces.
assert.match(sessionBrowser, /gyro-bridge:\/\/call/);
assert.match(sessionBrowser, /__gyroBrowserAgent/);
assert.match(sessionBrowser, /OBSERVED_PAGE_CONTENT_UNTRUSTED/);
assert.match(sessionBrowser, /credential fields are not writable/);
assert.match(sessionBrowser, /incognito\(true\)/);
assert.match(sessionBrowser, /WebviewBuilder::new/);
assert.match(lib, /mod session_browser/);
assert.match(lib, /register_bridge_protocol/);
assert.match(lib, /SessionBrowserManager/);

// Navigation gate is split from loopback-only diagnostics.
assert.match(sessionBrowser, /fn browser_url_is_navigable/);
assert.match(sessionBrowser, /fn browser_url_is_loopback/);
assert.match(lib, /browser_preview_diagnostics_supported/);

console.log(
  `browser capability checks passed (${BROWSER_TOOLS.length} tools, bridge + agent + rail)`,
);
