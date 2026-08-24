import assert from "node:assert/strict";

import {
  composerLimitWindows,
  estimateComposerContextUsage,
  formatLimitReset,
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
// The window is the selected model's, not the one some earlier turn recorded.
assert.equal(reported.windowLabel, "1.05M");
assert.equal(reported.percentLabel, "1%");
assert.match(reported.detail, /newer thread content and this draft/);

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
assert.match(switchedModel.detail, /ran on gpt-5\.6-sol/);

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

// A turn total is not what the window holds. Claude Code's closing frame sums
// every request the turn made, which read as "1.18M of 200K · 0 remaining"
// against a window six times smaller. A reading the window cannot hold is
// dropped and the thread estimate stands in, so sessions recorded before the
// fix stop reporting it too.
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
assert.equal(billingTotal.usedLabel, "500");
assert.equal(billingTotal.remainingLabel, "200K");

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
// for their model. The meter has to size itself from that record and keep
// estimating the usage, rather than fall back to a default window.
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
assert.equal(windowOnly.usedLabel, "1K");

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
assert.equal(merged[0].severity, "warning");
assert.equal(merged[1].id, "weekly");
assert.equal(merged[1].percent, undefined);

// Limits belong to the provider, not the thread: another provider's windows
// never carry over, so the meter falls back to its own unreported pair.
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
  [
    ["five-hour", undefined, "unknown"],
    ["weekly", undefined, "unknown"],
  ],
);

// A plan-based provider that has not reported yet still lists both windows,
// rather than showing a context bar with no limits under it.
const unreported = composerLimitWindows(
  [],
  { providerId: "anthropic" },
  [],
  now,
);
assert.deepEqual(
  unreported.map((window) => [window.id, window.label, window.percentLabel]),
  [
    ["five-hour", "5-hour limit", "—"],
    ["weekly", "Weekly limit", "—"],
  ],
);

// A reported window keeps its own label and level; only the missing half is
// filled in.
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
  [
    ["five-hour", "5-hour limit", undefined],
    ["weekly", "Weekly · all models", 42],
  ],
);

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

// Kimi meters the same pair Claude and Codex do, so it lists them before the
// first reading arrives rather than a context bar standing in for a plan.
const kimiDefaults = composerLimitWindows([], { providerId: "kimi" }, [], now);
assert.deepEqual(
  kimiDefaults.map((window) => [window.id, window.label, window.percentLabel]),
  [
    ["five-hour", "5-hour limit", "—"],
    ["weekly", "Weekly limit", "—"],
  ],
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
