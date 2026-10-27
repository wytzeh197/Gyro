import assert from "node:assert/strict";
import { remainingUsage } from "../packages/ui/src/usage-remaining.ts";

for (const [used, expected, label] of [
  [0, 100, "100%"],
  [46, 54, "54%"],
  [100, 0, "0%"],
  [105, 0, "0%"],
  [-5, 100, "100%"],
  [99.6, 0.4, "<1%"],
  [0.4, 99.6, ">99%"],
]) {
  const left = remainingUsage(used);
  assert.ok(Math.abs(left.percent - expected) < 1e-9);
  assert.equal(left.percentLabel, label);
}
for (const unknown of [undefined, NaN, Infinity]) {
  assert.equal(remainingUsage(unknown).percent, undefined);
  assert.equal(remainingUsage(unknown).percentLabel, "—");
}
assert.deepEqual(remainingUsage(undefined, true), {
  percent: 0,
  percentLabel: "0%",
});
assert.deepEqual(remainingUsage(25, true), { percent: 0, percentLabel: "0%" });
import {
  providerUsageFromSnapshot,
  providerUsageAfterError,
} from "../apps/desktop/src/provider-usage-state.ts";

import {
  composerContextUsageForModel,
  composerLimitWindows,
  contextOccupancyEpoch,
  estimateComposerContextUsage,
  formatLimitReset,
  holdContextOccupancyPeak,
  providerResetSummary,
} from "../packages/ui/src/context-usage.ts";

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
assert.equal(estimated.usedTokens, 0);
assert.equal(estimated.usedLabel, "0");
assert.equal(estimated.windowLabel, "400K");
assert.equal(estimated.percentLabel, "0%");
assert.equal(estimated.remainingPercentLabel, "100%");
assert.match(estimated.detail, /has not reported window occupancy/);
assert.equal(
  composerContextUsageForModel(estimated, {
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    contextWindowTokens: 500_000,
  }).contextWindowTokens,
  500_000,
  "A catalog update replaces an unreported baseline even for the same model",
);

for (const providerId of ["cursor", "opencode", "custom:unknown"]) {
  const unknown = estimateComposerContextUsage([], "x".repeat(1_600), {
    providerId,
    modelId: `${providerId}-default`,
  });
  assert.equal(unknown.usedTokens, 0);
  assert.equal(unknown.windowLabel, "Unknown");
  assert.equal(unknown.percentLabel, "—");
  assert.equal(unknown.remainingLabel, "Unknown");
  assert.equal(unknown.remainingPercent, undefined);
  assert.equal(unknown.remainingPercentLabel, "—");
  assert.match(unknown.label, /context window unknown/);
}

// Malformed or contradictory token readings must never be labeled measured.
for (const invalid of [
  { inputTokens: -1 },
  { inputTokens: 1.5 },
  { inputTokens: NaN },
  { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
  { inputTokens: 10, outputTokens: -1 },
  { inputTokens: 10, outputTokens: 5, totalTokens: 999 },
  { inputTokens: 10, outputTokens: 5, totalTokens: 0 },
  { inputTokens: 10, modelContextWindow: Infinity },
]) {
  const reading = estimateComposerContextUsage(
    [
      event("invalid", "assistant-message", "", {
        providerId: "openai",
        modelId: "fixture",
        contextUsage: invalid,
      }),
    ],
    "",
    { providerId: "openai", modelId: "fixture", contextWindowTokens: 1000 },
  );
  assert.equal(reading.source, "estimated");
  assert.equal(reading.usedTokens, 0);
  assert.equal(reading.contextWindowTokens, 1000);
}
const pureProvider = estimateComposerContextUsage(
  [
    event("pure", "assistant-message", "", {
      providerId: "openai",
      modelId: "fixture",
      contextUsage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
    }),
  ],
  "",
  { providerId: "openai", modelId: "fixture", contextWindowTokens: 1000 },
);
assert.equal(pureProvider.source, "reported");
assert.equal(pureProvider.usedTokens, 140);

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
assert.equal(
  reported.source,
  "reported",
  "A newer draft does not turn a provider measurement into an estimate",
);
assert.equal(reported.usedTokens, 12_000);
assert.equal(reported.usedLabel, "12K");

const trafficEstimate = estimateComposerContextUsage(
  [
    event("traffic", "system-event", "", {
      kind: "provider-context-usage",
      providerId: "xai",
      modelId: "grok-4.7",
      contextWindowSource: "catalog",
      contextUsage: {
        inputTokens: 120_000,
        totalTokens: 120_000,
        estimated: true,
        modelContextWindow: 500_000,
      },
    }),
  ],
  "",
  {
    providerId: "xai",
    modelId: "grok-4.7",
    modelLabel: "Grok 4.7",
    contextWindowTokens: 500_000,
  },
);
assert.equal(
  trafficEstimate.source,
  "estimated",
  "A traffic lower bound is not occupancy",
);
assert.equal(trafficEstimate.usedTokens, 0);
assert.match(trafficEstimate.detail, /has not reported window occupancy/);
assert.doesNotMatch(trafficEstimate.detail, /tool traffic/);
// A matching runtime window wins over the API/catalog maximum.
assert.equal(reported.windowLabel, "100K");
assert.equal(reported.percentLabel, "12%");
assert.equal(reported.remainingPercentLabel, "88%");
assert.match(reported.label, /12K of 100K tokens used \(12% used\)/);
assert.match(reported.detail, /reported by the provider/);
assert.equal(
  composerContextUsageForModel(reported, {
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    modelLabel: "GPT-5.6 Sol",
    contextWindowTokens: 1_050_000,
  }),
  reported,
  "Opening the picker on the same model preserves its runtime window",
);

for (const [providerId, modelId, window] of [
  ["openai", "gpt-6.1-sol", 500_000],
  ["xai", "grok-4.7", 256_000],
  ["antigravity", "antigravity-default", 0],
  ["openrouter", "z-ai/glm-5.3", 1_048_576],
]) {
  assert.equal(
    estimateComposerContextUsage([], "", { providerId, modelId })
      .contextWindowTokens,
    window,
  );
}

assert.equal(
  estimateComposerContextUsage([], "", {
    providerId: "gemini",
    modelId: "gemini-default",
  }).contextWindowTokens,
  0,
  "A retired provider must not advertise a guessed context allocation",
);

// A provisioned Kimi plan and a local Ollama allocation can differ from the
// offline catalog, in either direction. Counts must use the actual window.
for (const [providerId, modelId, catalog, runtime] of [
  ["kimi", "k3", 262_144, 1_048_576],
  ["ollama", "local-model", 131_072, 4_096],
]) {
  const actual = estimateComposerContextUsage(
    [
      event("runtime", "assistant-message", "", {
        providerId,
        modelId,
        contextUsage: { inputTokens: 1_024, modelContextWindow: runtime },
      }),
    ],
    "",
    { providerId, modelId, contextWindowTokens: catalog },
  );
  assert.equal(actual.contextWindowTokens, runtime);
  assert.equal(
    composerContextUsageForModel(actual, {
      providerId,
      modelId,
      contextWindowTokens: catalog,
    }).contextWindowTokens,
    runtime,
  );
  // An identical model ID served by a different provider must use its own window.
  assert.equal(
    composerContextUsageForModel(actual, {
      providerId: "custom:other",
      modelId,
      contextWindowTokens: 32_768,
    }).contextWindowTokens,
    32_768,
  );
}

// A model with no window of its own in the catalog still measures against the
// window the provider reported for it.
const catalogless = estimateComposerContextUsage(events, "", {
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  modelLabel: "GPT-5.6 Sol",
});
assert.equal(catalogless.windowLabel, "100K");
assert.equal(catalogless.percent, 12);

// Switching model does not empty the thread. The last measured occupancy is
// what the next send carries into whichever model reads it, so it stands rather
// than dropping the meter back to an estimate that reads as near-empty.
const switchedModel = estimateComposerContextUsage(events, "", {
  providerId: "openai",
  modelId: "gpt-5.4-mini",
  modelLabel: "GPT-5.4 mini",
  contextWindowTokens: 400_000,
});
assert.equal(switchedModel.source, "reported");
assert.equal(switchedModel.usedLabel, "12K");
assert.equal(switchedModel.windowLabel, "400K");
assert.match(switchedModel.detail, /reported by the provider/);
assert.doesNotMatch(switchedModel.detail, /ran on/);

// The same count stays visible on a provider that did not produce it.
const otherProvider = estimateComposerContextUsage(events, "", {
  providerId: "xai",
  modelId: "grok-4.7",
  modelLabel: "Grok 4.7",
  contextWindowTokens: 500_000,
});
assert.equal(otherProvider.source, "reported");
assert.equal(otherProvider.usedTokens, switchedModel.usedTokens);
assert.equal(otherProvider.windowLabel, "500K");
assert.match(otherProvider.detail, /reported by the provider/);

const smallerModel = estimateComposerContextUsage(events, "", {
  providerId: "custom:smaller",
  modelId: "small-model",
  contextWindowTokens: 4_096,
});
assert.equal(
  smallerModel.usedTokens,
  switchedModel.usedTokens,
  "Selecting a smaller model must preserve the observed conversation occupancy",
);
assert.equal(smallerModel.percent, 100);
assert.equal(smallerModel.remainingPercent, 0);
assert.equal(smallerModel.source, "reported");

const liveContext = {
  ...event("live-context", "system-event", "", {
    kind: "provider-context-usage",
    providerId: "openai",
    modelId: "fixture",
    contextUsage: {
      inputTokens: 120,
      outputTokens: 20,
      totalTokens: 140,
      modelContextWindow: 1000,
    },
  }),
  turnId: "live-turn",
};
const finalResponse = {
  ...event("final-context", "assistant-message", "", {
    kind: "provider-response",
    providerId: "openai",
    modelId: "fixture",
  }),
  turnId: "live-turn",
};
for (const contextUsage of [
  undefined,
  { modelContextWindow: 1000 },
  { inputTokens: 1.5 },
  { inputTokens: 2_000, totalTokens: 2_000, modelContextWindow: 1000 },
]) {
  const retained = estimateComposerContextUsage(
    [
      liveContext,
      {
        ...finalResponse,
        payload: { ...finalResponse.payload, contextUsage },
      },
    ],
    "",
    { providerId: "openai", modelId: "fixture", contextWindowTokens: 1000 },
  );
  assert.equal(
    retained.usedTokens,
    140,
    "A response without usable occupancy cannot erase the provider's stream observation",
  );
  assert.equal(retained.source, "reported");
}
const finalContext = {
  ...finalResponse,
  payload: {
    ...finalResponse.payload,
    contextUsage: {
      inputTokens: 160,
      outputTokens: 20,
      totalTokens: 180,
      modelContextWindow: 1000,
    },
  },
};
for (const ordered of [
  [liveContext, finalContext],
  [finalContext, liveContext],
]) {
  assert.equal(
    estimateComposerContextUsage(ordered, "", {
      providerId: "openai",
      modelId: "fixture",
      contextWindowTokens: 1000,
    }).usedTokens,
    180,
    "A final context observation supersedes a stale live checkpoint in either array order",
  );
}

const clamped = estimateComposerContextUsage(
  [
    event("5", "assistant-message", "full", {
      providerId: "openai",
      modelId: "tiny",
      contextUsage: {
        inputTokens: 999,
        outputTokens: 1,
        modelContextWindow: 1_000,
      },
    }),
  ],
  "x".repeat(4_000),
  { providerId: "openai", modelId: "tiny", modelLabel: "Tiny" },
);
assert.equal(clamped.percent, 100);
assert.equal(clamped.remainingLabel, "0");
assert.equal(clamped.remainingPercent, 0);
assert.equal(clamped.remainingPercentLabel, "0%");

// A turn total is not what the window holds. Claude Code's closing frame sums
// every request the turn made, which read as "1.18M of 200K · 0 remaining"
// against a window six times smaller. A reading the window cannot hold is
// dropped. Sessions recorded before the fix stop reporting it too.
const billingTotal = estimateComposerContextUsage(
  [
    event("9", "assistant-message", "z".repeat(2_000), {
      providerId: "anthropic",
      modelId: "claude-opus-5",
      contextUsage: {
        inputTokens: 1_171_092,
        outputTokens: 11_063,
        totalTokens: 1_182_155,
        modelContextWindow: 200_000,
      },
    }),
  ],
  "",
  {
    providerId: "anthropic",
    modelId: "claude-opus-5",
    modelLabel: "Claude Opus 5",
  },
);
assert.equal(billingTotal.source, "estimated");
assert.equal(billingTotal.windowLabel, "200K");
assert.equal(billingTotal.usedTokens, 0);
assert.equal(billingTotal.usedLabel, "0");
assert.equal(billingTotal.remainingLabel, "200K");

// A local checkpoint replaces the old provider thread. The stale
// pre-compaction reading must not win, and the digest is not a token count.
const checkpoint = estimateComposerContextUsage(
  [
    event("a", "assistant-message", "old", {
      providerId: "anthropic",
      modelId: "claude-opus-5",
      contextUsage: { inputTokens: 80_000, outputTokens: 1_000 },
    }),
    {
      ...event("b", "system-event", "Compacted context", {
        kind: "provider-activity",
        activityKind: "context",
        activityId: "context-compaction-checkpoint",
        status: "done",
        contextSummary: "S".repeat(4_000),
      }),
      turnId: "compact-turn",
    },
    event("c", "user-message", "next"),
  ],
  "",
  { providerId: "anthropic", modelId: "claude-opus-5" },
);
assert.equal(checkpoint.source, "estimated");
assert.equal(checkpoint.usedTokens, 0);

// A nearly untouched 1M window must not report more headroom than the window
// holds. Rounding the remainder to the nearest thousand reads "1000K", a unit
// the meter never uses and a number larger than the window it sits beside.
const nearlyEmpty = estimateComposerContextUsage(
  [
    event("6", "assistant-message", "hello", {
      providerId: "anthropic",
      modelId: "claude-opus-5",
      contextUsage: {
        inputTokens: 334,
        outputTokens: 0,
        totalTokens: 334,
        modelContextWindow: 1_000_000,
      },
    }),
  ],
  "",
  {
    providerId: "anthropic",
    modelId: "claude-opus-5",
    modelLabel: "Claude Opus 5",
    contextWindowTokens: 1_000_000,
  },
);
assert.equal(nearlyEmpty.usedLabel, "334");
assert.equal(nearlyEmpty.windowLabel, "1M");
assert.equal(nearlyEmpty.remainingLabel, "1M");
assert.equal(nearlyEmpty.percentLabel, "<1%");

// Providers that report no token counts still publish the window Gyro resolved
// for their model. The meter keeps that window and does not invent a usage.
const windowOnly = estimateComposerContextUsage(
  [
    event("7", "assistant-message", "hello", {
      providerId: "xai",
      modelId: "grok-4.5",
      contextUsage: { modelContextWindow: 131_072 },
    }),
    event("8", "user-message", "y".repeat(4_000)),
  ],
  "",
  { providerId: "xai", modelId: "grok-4.5", modelLabel: "Grok 4.5" },
);
assert.equal(windowOnly.source, "estimated");
assert.equal(windowOnly.windowLabel, "131K");
assert.equal(windowOnly.usedTokens, 0);
assert.equal(windowOnly.usedLabel, "0");

const grok46Fallback = estimateComposerContextUsage([], "hello", {
  providerId: "xai",
  modelId: "grok-4.6",
  modelLabel: "Grok 4.6",
});
assert.equal(grok46Fallback.windowLabel, "256K");
const grok47Fallback = estimateComposerContextUsage([], "hello", {
  providerId: "xai",
  modelId: "grok-4.7",
  modelLabel: "Grok 4.7",
});
assert.equal(grok47Fallback.windowLabel, "256K");

// Browsing another model must rescale the same occupancy against that
// model's window immediately, rather than keep the previous model's remaining.
const grok45Preview = composerContextUsageForModel(grok46Fallback, {
  providerId: "xai",
  modelId: "grok-4.5",
  modelLabel: "Grok 4.5",
  contextWindowTokens: 131_072,
});
assert.equal(grok45Preview.usedTokens, grok46Fallback.usedTokens);
assert.equal(grok45Preview.windowLabel, "131K");
assert.equal(grok45Preview.modelLabel, "Grok 4.5");
assert.match(grok45Preview.detail, /Grok 4\.5/);
const opusPreview = composerContextUsageForModel(grok46Fallback, {
  providerId: "anthropic",
  modelId: "claude-opus-5",
  modelLabel: "Claude Opus 5",
  contextWindowTokens: 1_000_000,
});
assert.equal(opusPreview.windowLabel, "1M");
assert.equal(opusPreview.remainingLabel, "1M");
assert.equal(
  composerContextUsageForModel(grok46Fallback, {
    providerId: "xai",
    modelId: "grok-4.6",
    modelLabel: "Grok 4.6",
    contextWindowTokens: 256_000,
  }),
  grok46Fallback,
);

const now = Date.parse("2026-07-27T10:00:00.000Z");

assert.equal(
  formatLimitReset("2026-07-27T14:31:00.000Z", now),
  "Resets in 4 hr 31 min",
);
assert.equal(
  formatLimitReset("2026-07-27T10:20:00.000Z", now),
  "Resets in 20 min",
);
assert.equal(formatLimitReset(undefined, now), undefined);
// A reset beyond the day is a calendar point; a countdown in days says less.
assert.match(formatLimitReset("2026-08-02T18:59:00.000Z", now), /^Resets \w/);

assert.equal(
  providerResetSummary(
    [
      {
        id: "weekly",
        label: "Weekly limit",
        resetsAt: "2026-07-27T22:00:00.000Z",
      },
      {
        id: "five-hour",
        label: "5-hour window",
        resetsAt: "2026-07-27T10:20:00.000Z",
      },
      { id: "unreported", label: "Other limit" },
    ],
    now,
  ),
  "5-hour resets in 20 min · Weekly resets in 12 hr",
);
assert.equal(
  providerResetSummary(
    [{ id: "invalid", label: "Invalid limit", resetsAt: "not-a-date" }],
    now,
  ),
  "",
);

// Claude Code names its windows and their resets but never measures how full
// they are. An unmeasured window must stay unmeasured rather than render as a
// bar sitting at zero, which reads as a full allowance.
const streamLimits = composerLimitWindows(
  [
    event("9", "assistant-message", "hi", {
      providerId: "anthropic",
      modelId: "claude-opus-5",
      rateLimits: [
        {
          id: "weekly",
          label: "Weekly · all models",
          status: "ok",
          resetsAt: "2026-08-02T18:59:00.000Z",
        },
        {
          id: "five-hour",
          label: "5-hour limit",
          status: "exhausted",
          usedPercent: 100,
          resetsAt: "2026-07-27T14:31:00.000Z",
        },
      ],
    }),
  ],
  { providerId: "anthropic", modelId: "claude-opus-5" },
  [],
  now,
);
assert.equal(streamLimits.length, 2);
// The shorter window is the one a run hits first, so it leads.
assert.equal(streamLimits[0].id, "five-hour");
assert.equal(streamLimits[0].percent, 100);
assert.equal(streamLimits[0].severity, "critical");
assert.equal(streamLimits[0].resetsLabel, "Resets in 4 hr 31 min");
assert.equal(streamLimits[1].id, "weekly");
assert.equal(streamLimits[1].percent, undefined);
assert.equal(streamLimits[1].percentLabel, "—");

// A polled snapshot is newer than anything read back off the thread, so it
// wins where both describe the same window.
const merged = composerLimitWindows(
  [
    event("10", "assistant-message", "hi", {
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      rateLimits: [{ id: "five-hour", label: "5-hour limit", status: "ok" }],
    }),
  ],
  { providerId: "openai", modelId: "gpt-5.6-sol" },
  [{ id: "five-hour", label: "5-hour limit", usedPercent: 84 }],
  now,
);
assert.equal(merged[0].id, "five-hour");
assert.equal(merged[0].percent, 84);
assert.equal(merged[0].remainingPercent, 16);
assert.equal(merged[0].remainingPercentLabel, "16%");
assert.equal(merged[0].severity, "warning");
assert.equal(merged.length, 1);

// Sources round the same reset differently (API 13:59:59.836, stream
// 14:00:00). A sub-second disagreement must not discard the measured level.
const roundedReset = composerLimitWindows(
  [
    event("12", "assistant-message", "hi", {
      providerId: "anthropic",
      rateLimits: [
        {
          id: "five-hour",
          label: "5-hour limit",
          usedPercent: 8,
          resetsAt: "2026-07-27T13:59:59.836Z",
        },
      ],
    }),
  ],
  { providerId: "anthropic" },
  [
    {
      id: "five-hour",
      label: "5-hour limit",
      status: "ok",
      resetsAt: "2026-07-27T14:00:00.000Z",
    },
  ],
  now,
);
assert.equal(roundedReset[0].percent, 8);

// Limits belong to the provider, not the thread: another provider's windows
// never carry over, and no default pair is invented.
const crossProvider = composerLimitWindows(
  [
    event("11", "assistant-message", "hi", {
      providerId: "anthropic",
      rateLimits: [
        { id: "five-hour", label: "5-hour limit", status: "exhausted" },
      ],
    }),
  ],
  { providerId: "openai" },
  [],
  now,
);
assert.deepEqual(
  crossProvider.map((window) => [window.id, window.percent, window.status]),
  [],
);

// No account reading means no inferred plan limits.
const unreported = composerLimitWindows(
  [],
  { providerId: "anthropic" },
  [],
  now,
);
assert.deepEqual(
  unreported.map((window) => [window.id, window.label, window.percentLabel]),
  [],
);

// A weekly-only account must not gain an invented five-hour limit.
const partial = composerLimitWindows(
  [
    event("12", "assistant-message", "hi", {
      providerId: "anthropic",
      rateLimits: [
        {
          id: "weekly",
          label: "Weekly · all models",
          usedPercent: 42,
          status: "ok",
        },
      ],
    }),
  ],
  { providerId: "anthropic" },
  [],
  now,
);
assert.deepEqual(
  partial.map((window) => [window.id, window.label, window.percent]),
  [["weekly", "Weekly · all models", 42]],
);

// Either account limit can exist alone, including a real zero reading.
for (const providerId of ["openai", "anthropic", "kimi", "xai"]) {
  for (const [id, label] of [
    ["weekly", "Weekly window"],
    ["five-hour", "5-hour limit"],
  ]) {
    assert.deepEqual(
      composerLimitWindows(
        [],
        { providerId },
        [{ id, label, usedPercent: 0 }],
        now,
      ).map((window) => [window.id, window.percent]),
      [[id, 0]],
    );
  }
}

// A provider naming its own allowance is left alone; the standard pair would
// be limits it never claimed.
const customWindows = composerLimitWindows(
  [
    event("13", "assistant-message", "hi", {
      providerId: "openai",
      rateLimits: [
        { id: "monthly", label: "Monthly credits", usedPercent: 12 },
      ],
    }),
  ],
  { providerId: "openai" },
  [],
  now,
);
assert.deepEqual(
  customWindows.map((window) => window.id),
  ["monthly"],
);

// Providers without plan windows stay empty rather than showing a pair they
// do not meter.
assert.equal(
  composerLimitWindows([], { providerId: "gemini" }, [], now).length,
  0,
);

// Kimi also waits for actual account limits before showing any rows.
const kimiDefaults = composerLimitWindows([], { providerId: "kimi" }, [], now);
assert.deepEqual(
  kimiDefaults.map((window) => [window.id, window.label, window.percentLabel]),
  [],
);

// A window Gyro does not model is the provider describing its own allowance,
// so the standard pair is not invented alongside it.
const customWindow = composerLimitWindows(
  [],
  { providerId: "openai" },
  [{ id: "monthly-credits", label: "Monthly credits", usedPercent: 12 }],
  now,
);
assert.deepEqual(
  customWindow.map((window) => window.id),
  ["monthly-credits"],
);

console.log("Composer context usage checks passed.");

// A partial stream event must not hide another still-active window.
const windowReset = new Date(now + 3_600_000).toISOString();
const separateWindows = [
  event("20", "assistant-message", "", {
    providerId: "anthropic",
    rateLimits: [
      {
        id: "weekly",
        label: "Weekly limit",
        usedPercent: 12,
        resetsAt: windowReset,
      },
    ],
  }),
  event("21", "assistant-message", "", {
    providerId: "anthropic",
    rateLimits: [
      {
        id: "five-hour",
        label: "5-hour limit",
        usedPercent: 93,
        resetsAt: windowReset,
      },
    ],
  }),
];
const retained = composerLimitWindows(
  separateWindows,
  { providerId: "anthropic" },
  [{ id: "five-hour", label: "5-hour limit", resetsAt: windowReset }],
  now,
);
assert.deepEqual(
  retained.map((window) => window.percent),
  [93, 12],
);
const expired = composerLimitWindows(
  separateWindows,
  { providerId: "anthropic" },
  [],
  now + 3_600_001,
);
// Past their reset the windows are spent-free, not gone: the plan still
// meters them, so the composer keeps the row at a full allowance.
assert.deepEqual(
  expired.map((window) => [
    window.id,
    window.remainingPercentLabel,
    window.resetsLabel,
  ]),
  [
    ["five-hour", "100%", undefined],
    ["weekly", "100%", undefined],
  ],
);
const newWindow = composerLimitWindows(
  separateWindows,
  { providerId: "anthropic" },
  [
    {
      id: "five-hour",
      label: "5-hour limit",
      resetsAt: new Date(now + 7_200_000).toISOString(),
    },
  ],
  now,
);
assert.equal(newWindow[0].percent, undefined);

// Cached backend fallbacks must reach the visible state with their real age
// and explanation, even though they still have usable windows.
const cachedState = providerUsageFromSnapshot({
  providerId: "anthropic",
  windows: [{ id: "five-hour", label: "5-hour limit", usedPercent: 93 }],
  fetchedAt: "2026-09-12T13:00:00Z",
  stale: true,
  error: "Rate limited",
});
assert.equal(cachedState.status, "available");
assert.equal(cachedState.stale, true);
assert.equal(cachedState.error, "Rate limited");
const offlineState = providerUsageAfterError(
  "anthropic",
  cachedState,
  "Offline",
);
assert.equal(offlineState.windows[0].usedPercent, 93);
assert.equal(offlineState.fetchedAt, cachedState.fetchedAt);
assert.equal(offlineState.error, "Offline");
const recoveredState = providerUsageFromSnapshot({
  providerId: "anthropic",
  windows: [{ id: "five-hour", label: "5-hour limit", usedPercent: 94 }],
  fetchedAt: "2026-09-12T13:02:00Z",
  stale: false,
});
assert.equal(recoveredState.error, undefined);
assert.equal(recoveredState.stale, false);
// Real stream updates must move the meter before a response is completed.
const {
  applyProviderChatStreamContextUsage,
  applyProviderChatStreamActivity,
  applyProviderChatStreamDeltas,
} = await import("../apps/desktop/src/provider-stream-events.ts");
for (const mode of ["normal", "plan", "goal", "council"]) {
  const model = {
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    contextWindowTokens: 100_000,
  };
  let live = [{ ...event("live-user", "user-message", "hello"), turnId: mode }];
  const ref = { current: new Map([["session-1", live]]) };
  const set = (update) => {
    live = typeof update === "function" ? update(live) : update;
  };
  const frame = {
    sessionId: "session-1",
    turnId: mode,
    providerId: "openai",
    modelId: model.modelId,
    eventId: "usage",
    sequence: 1,
    phase: "context-usage",
    contextUsage: {
      inputTokens: 12_000,
      outputTokens: 100,
      totalTokens: 12_100,
    },
  };
  applyProviderChatStreamContextUsage(ref, set, frame);
  assert.equal(
    estimateComposerContextUsage(live, "", model).usedTokens,
    12_100,
  );
  applyProviderChatStreamActivity(ref, set, {
    ...frame,
    phase: "activity",
    sequence: 2,
    activityId: "read",
    activityLabel: "Read",
    activityDetail: "x".repeat(400),
    activityStatus: "done",
  });
  assert.equal(
    estimateComposerContextUsage(live, "", model).usedTokens,
    12_100,
    "activity text is not occupancy",
  );
  applyProviderChatStreamDeltas(ref, set, [
    { ...frame, phase: "delta", sequence: 3, textDelta: "y".repeat(400) },
  ]);
  applyProviderChatStreamContextUsage(ref, set, {
    ...frame,
    sequence: 4,
    contextUsage: { inputTokens: 15_000, outputTokens: 100 },
  });
  assert.equal(
    estimateComposerContextUsage(live, "", model).usedTokens,
    15_100,
  );
  // Text that arrives after a reading is not occupancy.
  applyProviderChatStreamDeltas(ref, set, [
    { ...frame, phase: "delta", sequence: 5, textDelta: "z".repeat(400) },
  ]);
  assert.equal(
    estimateComposerContextUsage(live, "", model).usedTokens,
    15_100,
  );
  assert.equal(
    live.filter((item) => item.payload?.kind === "provider-context-usage")
      .length,
    1,
  );
  // Compaction is a replacement reading, not a monotonic billing total.
  applyProviderChatStreamContextUsage(ref, set, {
    ...frame,
    sequence: 6,
    contextUsage: { inputTokens: 3_000, outputTokens: 0 },
  });
  assert.equal(estimateComposerContextUsage(live, "", model).usedTokens, 3_000);
  live = live.map((item) =>
    item.kind === "assistant-message"
      ? {
          ...item,
          payload: {
            kind: "provider-response",
            contextUsage: { inputTokens: 4_000, outputTokens: 0 },
          },
        }
      : item,
  );
  assert.equal(estimateComposerContextUsage(live, "", model).usedTokens, 4_000);
}
const toolOnly = [
  event("tool", "system-event", "Read file", {
    kind: "provider-activity",
    detail: "x".repeat(4_000),
  }),
];
assert.equal(
  estimateComposerContextUsage(toolOnly, "", { providerId: "xai" }).usedTokens,
  0,
);
console.log("Live context stream checks passed.");

// A resend abandons the attempt that was running, so the newest reading is
// smaller than the one before it even though the chat itself is unchanged.
// The meter holds the peak so the bar never reads as history going missing,
// which is the same rule for every provider and model because it only
// compares reported numbers.
const peakModel = {
  providerId: "deepseek",
  modelId: "deepseek-v4.1",
  modelLabel: "DeepSeek V4.1",
  contextWindowTokens: 1_048_576,
};
const chatStart = [event("1", "user-message", "why did the meter drop?")];
const epoch = contextOccupancyEpoch(chatStart);
const measured = (id, tokens) =>
  event(id, "assistant-message", "", {
    providerId: peakModel.providerId,
    modelId: peakModel.modelId,
    contextUsage: {
      inputTokens: tokens,
      outputTokens: 0,
      totalTokens: tokens,
    },
  });
const longAttempt = estimateComposerContextUsage(
  [...chatStart, measured("long", 100_000)],
  "",
  peakModel,
);
const afterResend = estimateComposerContextUsage(
  [...chatStart, measured("short", 8_000)],
  "",
  peakModel,
);
assert.ok(
  afterResend.usedTokens < longAttempt.usedTokens,
  "a resend re-bases the raw reading on the smaller prompt",
);
const firstReading = holdContextOccupancyPeak(undefined, longAttempt, epoch);
assert.equal(firstReading.usage.usedTokens, longAttempt.usedTokens);
const heldReading = holdContextOccupancyPeak(
  firstReading.peak,
  afterResend,
  epoch,
);
assert.equal(
  heldReading.usage.usedTokens,
  longAttempt.usedTokens,
  "the meter keeps the peak a resend abandoned",
);
assert.equal(heldReading.usage.percent, longAttempt.percent);
assert.match(heldReading.usage.detail, /highest occupancy this chat has reached/);
// The same epoch across a fresh attempt: a second resend cannot walk it back.
assert.equal(
  holdContextOccupancyPeak(
    holdContextOccupancyPeak(heldReading.peak, afterResend, epoch).peak,
    afterResend,
    epoch,
  ).usage.usedTokens,
  longAttempt.usedTokens,
);

// A compaction really does release the thread, so the peak starts over.
const compacted = event("9", "system-event", "Compacted context", {
  kind: "provider-activity",
  activityKind: "context",
  activityId: "context-compaction-1",
  status: "done",
});
const releasedEpoch = contextOccupancyEpoch([...chatStart, compacted]);
assert.notEqual(releasedEpoch, epoch);
assert.equal(
  holdContextOccupancyPeak(heldReading.peak, afterResend, releasedEpoch).usage
    .usedTokens,
  afterResend.usedTokens,
);

// Every other activity row leaves the epoch alone, for every provider.
const toolRow = event("8", "system-event", "Read chat-run.ts", {
  kind: "provider-activity",
  activityKind: "tools",
  activityId: "tool-1",
  status: "done",
});
assert.equal(contextOccupancyEpoch([...chatStart, toolRow]), epoch);
assert.equal(
  contextOccupancyEpoch([
    ...chatStart.map((item) => ({ ...item, sessionId: "session-2" })),
  ]) === epoch,
  false,
  "another chat never inherits this peak",
);

// A peak that does not fit the selected window must not claim it is full.
const smallWindow = {
  ...peakModel,
  modelId: "small",
  modelLabel: "Small",
  contextWindowTokens: 64_000,
};
const smallReading = estimateComposerContextUsage(
  [...chatStart, measured("small", 8_000)],
  "",
  smallWindow,
);
const narrowed = holdContextOccupancyPeak(
  heldReading.peak,
  smallReading,
  epoch,
);
assert.equal(narrowed.usage.usedTokens, smallReading.usedTokens);
assert.ok(narrowed.usage.percent < 100);

// Selecting the large model again restores the peak the chat reached.
assert.equal(
  holdContextOccupancyPeak(narrowed.peak, afterResend, epoch).usage.usedTokens,
  longAttempt.usedTokens,
);
console.log("Context peak checks passed.");
