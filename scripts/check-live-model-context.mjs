import assert from "node:assert/strict";
import { applyModelContextWindows, liveModelContextTokens } from "../packages/ui/src/live-model-context.ts";
import { providerCatalog, providersForConfig } from "../packages/ui/src/provider-catalog.ts";
import { estimateComposerContextUsage, composerContextUsageForModel } from "../packages/ui/src/context-usage.ts";
import { applyProviderChatStreamContextUsage } from "../apps/desktop/src/provider-stream-events.ts";

const now = Date.now();
const checkedAt = new Date(now).toISOString();
const empty = { commandProfiles: [], modelProviders: [], telemetryEnabled: false,
  requireCommandApproval: true, requireFileEditApproval: true };
const config = { ...empty, modelProviders: providersForConfig(empty) };
let modelsChecked = 0;
for (const provider of config.modelProviders) {
  for (const model of provider.models) {
    const usage = estimateComposerContextUsage([], "x".repeat(400), {
      providerId: provider.id, modelId: model.id, contextWindowTokens: model.contextWindowTokens,
    });
    assert.equal(usage.contextWindowTokens, model.contextWindowTokens ?? 0, provider.id + ":" + model.id);
    modelsChecked++;
  }
  assert.equal(estimateComposerContextUsage([], "", {
    providerId: provider.id, modelId: "never-advertised-model",
  }).contextWindowTokens, 0, "No provider-wide context guess: " + provider.id);
}

const row = (providerId, modelId, tokens, source = "provider", timestamp = checkedAt) => ({
  providerId, modelId, contextWindowTokens: tokens, source, checkedAt: timestamp,
});
let updated = applyModelContextWindows(config, [
  row("xai", "grok-4.7", 128_000, "runtime"),
  row("xai", "grok-4.5", 200_000),
  row("openrouter", "x-ai/grok-4.7", 256_000),
  row("cursor", "cursor-default", 64_000, "runtime"),
], now);
const find = (saved, p, m) => providersForConfig(saved).find(provider => provider.id === p).models.find(model => model.id === m);
assert.equal(find(updated, "xai", "grok-4.7").contextWindowTokens, 128_000);
assert.equal(find(updated, "xai", "grok-4.5").contextWindowTokens, 200_000);
assert.equal(find(updated, "openrouter", "x-ai/grok-4.7").contextWindowTokens, 256_000);
assert.equal(find(updated, "cursor", "cursor-default").contextWindowTokens, 64_000);
assert.equal(find(config, "xai", "grok-4.7").contextWindowTokens, 128_000,
  "A config reload/model selection preserves the live registry");
updated = applyModelContextWindows(updated, [row("xai", "grok-4.7", 500_000)], now);
assert.equal(find(updated, "xai", "grok-4.7").contextWindowTokens, 128_000,
  "Published maxima cannot replace an actual session allocation");
updated = applyModelContextWindows(updated, [row("xai", "grok-4.7", 256_000, "runtime", new Date(now - 1_000).toISOString())], now);
assert.equal(find(updated, "xai", "grok-4.7").contextWindowTokens, 128_000,
  "An older asynchronous response cannot replace a newer runtime reading");
for (const tokens of [0, -1, 1.5, NaN, Infinity, "1000000", 100_000_001]) {
  assert.equal(liveModelContextTokens({ liveContextWindow: { tokens, source: "provider", checkedAt } }, now), undefined);
}
assert.equal(liveModelContextTokens({ liveContextWindow: {
  tokens: 1_000_000, source: "provider", checkedAt: new Date(now - 300_001).toISOString(),
} }, now), undefined);
assert.equal(liveModelContextTokens({ liveContextWindow: {
  tokens: 1_000_000, source: "runtime", checkedAt: new Date(now - 900_001).toISOString(),
} }, now), undefined);

const custom = { ...empty, modelProviders: [{
  id: "custom:ctx", kind: "openai-compatible", displayName: "Fixture endpoint",
  baseUrl: "http://localhost:9000/v1", apiKeyRef: "", enabled: true,
  modelIds: ["actual-model"], models: [{ id: "actual-model", displayName: "Actual model" }],
}] };
const customLive = applyModelContextWindows(custom, [row("custom:ctx", "actual-model", 32_768)], now);
assert.equal(find(customLive, "custom:ctx", "actual-model").contextWindowTokens, 32_768);
const changedEndpoint = { ...customLive, modelProviders: customLive.modelProviders.map(provider => ({
  ...provider, baseUrl: "http://localhost:9001/v1",
})) };
assert.equal(find(changedEndpoint, "custom:ctx", "actual-model").contextWindowTokens, undefined,
  "Context from the old endpoint cannot leak into the new endpoint");

const optimistic = { current: new Map() };
let events = [];
const setEvents = (update) => { events = update(events); };
applyProviderChatStreamContextUsage(optimistic, setEvents, {
  sessionId: "fixture", turnId: "live-turn", providerId: "xai", modelId: "grok-4.7",
  eventId: "a", sequence: 1, phase: "context-usage", contextWindowSource: "runtime",
  contextUsage: { inputTokens: 50_000, totalTokens: 50_000, modelContextWindow: 128_000 },
});
let usage = estimateComposerContextUsage(events, "", { providerId: "xai", modelId: "grok-4.7", contextWindowTokens: 500_000 });
assert.equal(usage.contextWindowTokens, 128_000);
assert.equal(usage.usedTokens, 50_000);
assert.equal(usage.source, "reported");
applyProviderChatStreamContextUsage(optimistic, setEvents, {
  sessionId: "fixture", turnId: "live-turn", providerId: "xai", modelId: "grok-4.7",
  eventId: "b", sequence: 2, phase: "context-usage", contextWindowSource: "runtime",
  contextUsage: { inputTokens: 64_000, totalTokens: 64_000, modelContextWindow: 128_000 },
});
assert.equal(events.length, 1, "Live occupancy replaces the checkpoint rather than accumulating billed consumption");
usage = estimateComposerContextUsage(events, "", { providerId: "xai", modelId: "grok-4.7", contextWindowTokens: 500_000 });
assert.equal(usage.usedTokens, 64_000);
assert.equal(usage.percent, 50);
assert.equal(composerContextUsageForModel(usage, { providerId: "xai", modelId: "grok-4.3", contextWindowTokens: 1_000_000 }).contextWindowTokens, 1_000_000);

const catalogOnly = events.map(event => ({ ...event, payload: { ...event.payload, contextWindowSource: "catalog" } }));
assert.equal(estimateComposerContextUsage(catalogOnly, "", {
  providerId: "xai", modelId: "grok-4.7", contextWindowTokens: 256_000,
}).contextWindowTokens, 256_000, "An old catalog checkpoint cannot freeze a refreshed model limit");
console.log("Live context: " + config.modelProviders.length + " providers / " + modelsChecked + " models; runtime, switching, unknown, scope, expiry, and streaming checks passed.");
