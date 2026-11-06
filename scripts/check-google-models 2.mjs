import assert from "node:assert/strict";
import { applyGoogleModelDiscovery } from "../packages/ui/src/google-models.ts";
import {
  providerCatalog,
  providersForConfig,
  providerSupportsApiKey,
  normalizedConfig,
  isProviderId,
} from "../packages/ui/src/provider-catalog.ts";

const source = providerCatalog.find(
  (provider) => provider.id === "antigravity",
);
assert.equal(source.capabilities.executionKind, "acp-cli");
assert.equal(source.capabilities.supportsApprovals, true);
assert.equal(source.authMode, "env");
assert.equal(providerSupportsApiKey("antigravity"), true);
assert.equal(isProviderId("gemini"), false);
assert.equal(providerSupportsApiKey("gemini"), false);
// Old installs must not resurrect Gemini, reuse its OAuth connection, or keep
// a retired CLI entry in New Session.
const legacy = {
  selectedProviderId: "gemini",
  commandProfiles: [
    { id: "gemini-cli", command: "gemini", args: [], providerId: "gemini" },
    { id: "my-shell", command: "zsh", args: [] },
  ],
  modelProviders: [{ id: "gemini", enabled: true, authStatus: "connected" }],
};
const retired = normalizedConfig(legacy);
assert.ok(!retired.modelProviders.some((provider) => provider.id === "gemini"));
assert.equal(retired.selectedProviderId, undefined);
assert.equal(retired.modelProviders.find((provider) => provider.id === "antigravity").enabled, false);
assert.deepEqual(retired.commandProfiles.map((profile) => profile.id), ["my-shell"]);
const connectedReplacement = normalizedConfig({
  ...legacy,
  modelProviders: [...legacy.modelProviders, { ...source, enabled: true, authStatus: "connected" }],
});
assert.equal(connectedReplacement.selectedProviderId, "antigravity");
const original = {
  modelProviders: [
    {
      ...source,
      selectedModelId: "old-discovered",
      models: [
        ...source.models,
        { id: "manual", displayName: "Manual model" },
        { id: "old-discovered", displayName: "Old model", cliDiscovered: true },
      ],
    },
  ],
};
const next = applyGoogleModelDiscovery(original, "antigravity", {
  currentModelId: "gemini-3.8-flash",
  models: [
    { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
    { id: "gemini-3.8-flash", displayName: "Duplicate" },
    { id: "", displayName: "Invalid" },
  ],
});
const provider = providersForConfig(next).find(
  (provider) => provider.id === "antigravity",
);
assert.deepEqual(
  provider.models.map((model) => model.id),
  ["antigravity-default", "manual", "gemini-3.8-flash"],
);
assert.equal(provider.selectedModelId, "gemini-3.8-flash");
assert.equal(provider.models.at(-1).contextWindowTokens, undefined);
assert.equal(provider.models.at(-1).supportedReasoningEfforts, undefined);
assert.equal(original.modelProviders[0].models.at(-1).id, "old-discovered");
assert.equal(
  applyGoogleModelDiscovery(original, "openai", { models: [] }),
  original,
);
const unchanged = applyGoogleModelDiscovery(next, "antigravity", {
  models: [],
});
assert.equal(
  providersForConfig(unchanged).find(
    (provider) => provider.id === "antigravity",
  ).selectedModelId,
  "antigravity-default",
);
assert.ok(!provider.models.some((model) => /argon|gemini-4/.test(model.id)));
console.log(
  "Google discovery merging, stale selections, provider isolation, and honest metadata checks passed.",
);
