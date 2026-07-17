import assert from "node:assert/strict";

import { estimateComposerContextUsage } from "../packages/ui/src/context-usage.ts";

function event(id, kind, message, payload = {}) {
  return {
    id,
    sessionId: "session-1",
    createdAt: `2026-07-17T14:00:0${id}.000Z`,
    kind,
    message,
    payload,
  };
}

const estimated = estimateComposerContextUsage([], "x".repeat(1_600), {
  providerId: "openai",
  modelId: "gpt-5.4-mini",
  modelLabel: "GPT-5.4 mini",
  contextWindowTokens: 400_000,
});
assert.equal(estimated.source, "estimated");
assert.equal(estimated.usedLabel, "400");
assert.equal(estimated.windowLabel, "400K");
assert.equal(estimated.percentLabel, "<1%");

const events = [
  event("1", "assistant-message", "old model", {
    providerId: "openai",
    modelId: "gpt-5.6-terra",
    contextUsage: {
      inputTokens: 80_000,
      outputTokens: 10_000,
      totalTokens: 90_000,
      modelContextWindow: 1_050_000,
    },
  }),
  event("2", "assistant-message", "current model", {
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    contextUsage: {
      inputTokens: 10_000,
      outputTokens: 2_000,
      totalTokens: 12_000,
      modelContextWindow: 100_000,
    },
  }),
  event("3", "system-event", "OpenAI is ready"),
  event("4", "user-message", "y".repeat(400)),
];
const reported = estimateComposerContextUsage(events, "z".repeat(400), {
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  modelLabel: "GPT-5.6 Sol",
  contextWindowTokens: 1_050_000,
});
assert.equal(reported.source, "reported");
assert.equal(reported.usedLabel, "12K");
assert.equal(reported.remainingLabel, "88K");
assert.equal(reported.windowLabel, "100K");
assert.equal(reported.percent, 12);
assert.match(reported.detail, /newer thread content and this draft/);

const switchedModel = estimateComposerContextUsage(events, "", {
  providerId: "openai",
  modelId: "gpt-5.4-mini",
  modelLabel: "GPT-5.4 mini",
  contextWindowTokens: 400_000,
});
assert.equal(switchedModel.source, "estimated");
assert.equal(switchedModel.windowLabel, "400K");

const clamped = estimateComposerContextUsage(
  [
    event("5", "assistant-message", "full", {
      providerId: "openai",
      modelId: "tiny",
      contextUsage: { inputTokens: 2_000, modelContextWindow: 1_000 },
    }),
  ],
  "",
  { providerId: "openai", modelId: "tiny", modelLabel: "Tiny" },
);
assert.equal(clamped.percent, 100);
assert.equal(clamped.remainingLabel, "0");

console.log("Composer context usage checks passed.");
