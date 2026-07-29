import assert from "node:assert/strict";

import {
  providerCatalog,
  providersForConfig,
} from "../packages/ui/src/provider-catalog.ts";

function config(providerOverrides) {
  return {
    telemetryEnabled: false,
    requireCommandApproval: true,
    requireFileEditApproval: true,
    modelProviders: providerOverrides,
    commandProfiles: [],
  };
}

function resolved(providerId, overrides) {
  return providersForConfig(config([overrides])).find(
    (provider) => provider.id === providerId,
  );
}

// A credential ref saved by an older release must not outlive the auth mode it
// belonged to. xAI shipped as env-key based before moving to Grok CLI sign-in;
// the stale ref made the provider card contradict itself and steers the health
// check toward reading an environment variable instead of the CLI login.
const staleXai = resolved("xai", {
  id: "xai",
  displayName: "xAI",
  baseUrl: null,
  apiKeyRef: "provider-env:XAI_API_KEY",
  enabled: true,
});
assert.equal(staleXai.authMode, "cli");
assert.equal(staleXai.apiKeyRef, "provider-cli:grok");

// Every CLI provider in the catalog reports a CLI-owned ref.
for (const provider of providersForConfig(config([]))) {
  if (provider.authMode !== "cli") continue;
  assert.match(
    provider.apiKeyRef,
    /^provider(-cli)?:/,
    `${provider.id} should carry a CLI credential ref, got ${provider.apiKeyRef}`,
  );
  const catalogEntry = providerCatalog.find((item) => item.id === provider.id);
  assert.equal(provider.apiKeyRef, catalogEntry.apiKeyRef);
}

// A provider genuinely on env auth keeps the ref that names its variable.
const envProvider = resolved("xai", {
  id: "xai",
  displayName: "xAI",
  baseUrl: null,
  apiKeyRef: "provider-env:XAI_API_KEY",
  authMode: "env",
  enabled: true,
});
assert.equal(envProvider.authMode, "env");
assert.equal(envProvider.apiKeyRef, "provider-env:XAI_API_KEY");

console.log("provider identity checks passed");
