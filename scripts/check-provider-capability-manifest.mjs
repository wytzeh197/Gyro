import assert from "node:assert/strict";

import {
  applyProviderCapabilityManifest,
  getProviderCatalogEntry,
} from "../packages/ui/src/provider-catalog.ts";

const antigravity = getProviderCatalogEntry("antigravity");
assert.equal(antigravity?.capabilities.executionKind, "antigravity-cli");
assert.equal(antigravity?.capabilities.executable, true);
assert.equal(antigravity?.capabilities.supportsApprovals, false);
assert.equal(antigravity?.capabilities.supportsImages, false);
assert.deepEqual(antigravity?.allowedTools, []);
for (const id of ["antigravity", "cursor", "opencode"]) {
  assert.equal(getProviderCatalogEntry(id)?.capabilities.visibility, "standard");
}

const allCapabilities = [
  "workspace-context",
  "workspace-diff",
  "terminal-open",
  "browser-open",
  "github-push",
];

applyProviderCapabilityManifest([
  {
    schema: "gyro.provider-capability-manifest.v1",
    providerId: "anthropic",
    available: true,
    executionKind: "claude-code",
    supportTier: "supported",
    supportsApprovals: true,
    supportsImages: true,
    supportsResume: true,
    supportsUsage: true,
    capabilities: allCapabilities,
  },
  {
    schema: "gyro.provider-capability-manifest.v1",
    providerId: "cursor",
    available: true,
    executionKind: "acp-cli",
    supportTier: "experimental",
    supportsApprovals: true,
    supportsImages: false,
    supportsResume: true,
    supportsUsage: false,
    capabilities: ["workspace-context", "terminal-open"],
  },
  {
    schema: "gyro.provider-capability-manifest.v1",
    providerId: "antigravity",
    available: false,
    executionKind: "antigravity-cli",
    supportTier: "experimental",
    supportsApprovals: false,
    supportsImages: true,
    supportsResume: true,
    supportsUsage: true,
    capabilities: [],
    reason: "This chat adapter does not connect Gyro tools.",
  },
]);

const anthropic = getProviderCatalogEntry("anthropic");
assert.equal(anthropic?.capabilities.executionKind, "claude-code");
assert.deepEqual(anthropic?.allowedTools, [
  "files",
  "terminal",
  "diff",
  "browser",
]);

const cursor = getProviderCatalogEntry("cursor");
assert.equal(cursor?.capabilities.visibility, "experimental");
assert.deepEqual(cursor?.allowedTools, ["files", "terminal"]);

assert.equal(antigravity?.capabilities.executionKind, "antigravity-cli");
assert.equal(antigravity?.capabilities.executable, true);
assert.equal(antigravity?.capabilities.visibility, "experimental");
assert.deepEqual(antigravity?.allowedTools, []);

// Executability follows the adapter, rather than tool availability.
applyProviderCapabilityManifest([
  {
    schema: "gyro.provider-capability-manifest.v1",
    providerId: "openai",
    available: false,
    executionKind: "readiness-only",
    supportTier: "readiness-only",
    supportsApprovals: false,
    supportsImages: false,
    supportsResume: false,
    supportsUsage: false,
    capabilities: [],
  },
]);
const readinessOnly = getProviderCatalogEntry("openai");
assert.equal(readinessOnly?.capabilities.executable, false);
assert.equal(readinessOnly?.capabilities.visibility, "readiness-only");
assert.deepEqual(readinessOnly?.allowedTools, []);

console.log("provider capability manifest checks passed");
