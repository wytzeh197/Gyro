import assert from "node:assert/strict";

import {
  applyProviderCapabilityManifest,
  getProviderCatalogEntry,
} from "../packages/ui/src/provider-catalog.ts";

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

console.log("provider capability manifest checks passed");
