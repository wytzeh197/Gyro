import assert from "node:assert/strict";
import {
  providerUsageFromSnapshot,
  providerUsageAfterError,
} from "../apps/desktop/src/provider-usage-state.ts";

import {
  composerContextUsageForModel,
  composerLimitWindows,
  estimateComposerContextUsage,
  formatLimitReset,
  formatUsageFreshness,
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

const grok46Fallback = estimateComposerContextUsage([], "hello", {
  providerId: "xai",
  modelId: "grok-4.6",
  modelLabel: "Grok 4.6",
});
assert.equal(grok46Fallback.windowLabel, "500K");
const grok47Fallback = estimateComposerContextUsage([], "hello", {
  providerId: "xai",
  modelId: "grok-4.7",
  modelLabel: "Grok 4.7",
});
assert.equal(grok47Fallback.windowLabel, "500K");

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
    contextWindowTokens: 500_000,
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

// An old or failed reading says so instead of passing for a live one.
const freshnessNow = Date.parse("2026-07-27T10:00:00.000Z");
assert.deepEqual(
  formatUsageFreshness("2026-07-27T09:59:40.000Z", freshnessNow),
  { label: "Updated just now", stale: false },
);
assert.deepEqual(
  formatUsageFreshness("2026-07-26T20:00:00.000Z", freshnessNow),
  { label: "Last read 14 hr ago", stale: true },
);
assert.equal(
  formatUsageFreshness("2026-07-27T09:58:00.000Z", freshnessNow, true)?.stale,
  true,
);
assert.equal(formatUsageFreshness(undefined, freshnessNow), undefined);

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
assert.deepEqual(
  expired.map((window) => window.percent),
  [],
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
  assert.ok(estimateComposerContextUsage(live, "", model).usedTokens > 12_100);
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
  // Growing an existing assistant row must count only text after the reading.
  applyProviderChatStreamDeltas(ref, set, [
    { ...frame, phase: "delta", sequence: 5, textDelta: "z".repeat(400) },
  ]);
  assert.equal(
    estimateComposerContextUsage(live, "", model).usedTokens,
    15_200,
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
assert.ok(
  estimateComposerContextUsage(toolOnly, "", { providerId: "xai" })
    .usedTokens >= 1_000,
);
console.log("Live context stream checks passed.");
