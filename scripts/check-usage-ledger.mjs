import assert from "node:assert/strict";

import {
  estimateTurnCost,
  ledgerWindows,
  formatTokenCount,
  isOutsizedTurn,
  planUsageNotices,
  summarizeSessionCost,
  summarizeUsageSafety,
} from "../packages/ui/src/usage-ledger.ts";

assert.deepEqual(
  planUsageNotices("openai", [
    { id: "five-hour", label: "5-hour window", usedPercent: 82, resetsAt: "2026-08-29T00:00:00.000Z" },
    { id: "week", label: "Weekly window", usedPercent: 49 },
  ]),
  [{
    providerId: "openai",
    windowId: "five-hour",
    windowLabel: "5-hour window",
    percent: 82,
    threshold: 80,
    cycleId: "2026-08-29T00:00:00.000Z",
  }],
);

function totals(overrides = {}) {
  return {
    calls: 0,
    measuredCalls: 0,
    estimatedCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    byOrigin: [],
    ...overrides,
  };
}

// Units match the composer context meter so the two never disagree.
assert.equal(formatTokenCount(0), "0");
assert.equal(formatTokenCount(940), "940");
assert.equal(formatTokenCount(1_200), "1.2K");
assert.equal(formatTokenCount(12_400), "12K");
assert.equal(formatTokenCount(1_240_000), "1.24M");
assert.equal(formatTokenCount(12_400_000), "12M");

// A chat that has spent nothing says so rather than rendering a zero.
const empty = summarizeSessionCost(undefined);
assert.equal(empty.isEmpty, true);
assert.equal(summarizeSessionCost(totals()).isEmpty, true);

// An ordinary chat needs no breakdown: the call count already says it.
const plainChat = summarizeSessionCost(
  totals({
    calls: 6,
    measuredCalls: 6,
    totalTokens: 240_000,
    byOrigin: [{ origin: "chat", label: "Chat", calls: 6, totalTokens: 240_000 }],
  }),
);
assert.equal(plainChat.label, "240K tokens · 6 calls");
assert.equal(plainChat.breakdown, undefined);
assert.equal(plainChat.estimateNote, undefined);

// A council turn is where the multiplier becomes visible: one keypress, five calls.
const council = summarizeSessionCost(
  totals({
    calls: 7,
    measuredCalls: 7,
    totalTokens: 1_240_000,
    byOrigin: [
      {
        origin: "council-seat",
        label: "Council seats",
        calls: 4,
        totalTokens: 900_000,
      },
      {
        origin: "council-synthesis",
        label: "Council synthesis",
        calls: 1,
        totalTokens: 240_000,
      },
      { origin: "chat", label: "Chat", calls: 2, totalTokens: 100_000 },
    ],
  }),
);
assert.equal(council.label, "1.24M tokens · 7 calls");
assert.equal(
  council.breakdown,
  "council seats 4 · council synthesis 1 · chat 2",
);
assert.match(council.title, /1\.24M tokens across 7 provider calls/);

// Estimates are labelled, never blended into a confident number.
const mixed = summarizeSessionCost(
  totals({
    calls: 5,
    measuredCalls: 3,
    estimatedCalls: 2,
    totalTokens: 80_000,
    byOrigin: [{ origin: "chat", label: "Chat", calls: 5, totalTokens: 80_000 }],
  }),
);
assert.equal(mixed.estimateNote, "2 estimated");
assert.match(mixed.title, /report no token counts/);

const allEstimated = summarizeSessionCost(
  totals({
    calls: 2,
    estimatedCalls: 2,
    totalTokens: 40_000,
    byOrigin: [{ origin: "chat", label: "Chat", calls: 2, totalTokens: 40_000 }],
  }),
);
assert.equal(allEstimated.estimateNote, "estimated");
assert.match(allEstimated.title, /the total is estimated/);

// An automation quietly outspending the chat has to be visible in the split.
const automated = summarizeSessionCost(
  totals({
    calls: 4,
    measuredCalls: 4,
    totalTokens: 500_000,
    byOrigin: [
      {
        origin: "automation",
        label: "Automations",
        calls: 3,
        totalTokens: 450_000,
      },
      { origin: "chat", label: "Chat", calls: 1, totalTokens: 50_000 },
    ],
  }),
);
assert.equal(automated.breakdown, "automations 3 · chat 1");

// A tool-using turn bills the same conversation once per call. The total keeps
// counting it — budgets are measured against that figure — but the line says
// how much of it was context being re-read.
const toolHeavy = summarizeSessionCost(
  totals({
    calls: 9,
    measuredCalls: 9,
    inputTokens: 567_771,
    cachedInputTokens: 565_389,
    totalTokens: 600_000,
    byOrigin: [{ origin: "chat", label: "Chat", calls: 9, totalTokens: 600_000 }],
  }),
);
assert.equal(toolHeavy.label, "600K tokens · 9 calls");
assert.equal(toolHeavy.cachedNote, "565K re-read");
assert.match(toolHeavy.title, /context re-read on each call/);

// Below the threshold the split is noise, and an unmeasured provider reports no
// cache reading at all, so neither claims one.
assert.equal(
  summarizeSessionCost(
    totals({
      calls: 4,
      measuredCalls: 4,
      cachedInputTokens: 20_000,
      totalTokens: 200_000,
      byOrigin: [{ origin: "chat", label: "Chat", calls: 4, totalTokens: 200_000 }],
    }),
  ).cachedNote,
  undefined,
);
assert.equal(allEstimated.cachedNote, undefined);

// Outsized-turn detection needs a baseline before it will call anything unusual.
const baseline = totals({ calls: 6, totalTokens: 600_000 });
assert.equal(isOutsizedTurn(400_000, baseline), true);
assert.equal(isOutsizedTurn(120_000, baseline), false);
assert.equal(isOutsizedTurn(400_000, totals({ calls: 2, totalTokens: 10 })), false);
assert.equal(isOutsizedTurn(0, baseline), false);

// An ordinary turn is one call and never interrupts.
const normalTurn = estimateTurnCost({
  chatMode: "normal",
  contextTokens: 40_000,
});
assert.equal(normalTurn.calls, 1);
assert.equal(normalTurn.multiplier, 1);
assert.equal(normalTurn.needsConfirm, false);
assert.equal(normalTurn.label, "1 call · ~40K tokens");

// A Council send is its seats plus the synthesis: the multiplier is the part
// that goes unnoticed at the moment Enter is pressed.
const councilTurn = estimateTurnCost({
  chatMode: "council",
  contextTokens: 60_000,
  seatCount: 4,
});
assert.equal(councilTurn.calls, 5);
assert.equal(councilTurn.multiplier, 5);
assert.equal(councilTurn.tokens, 60_000 * 4 + 24_000);
assert.match(councilTurn.label, /5 calls · ~264K tokens · 5× a normal turn/);

// Plan mode is still a single call, however large its context.
assert.equal(
  estimateTurnCost({ chatMode: "plan", contextTokens: 90_000 }).calls,
  1,
);

// A big fan-out has to be agreed to rather than merely displayed.
const bigCouncil = estimateTurnCost({
  chatMode: "council",
  contextTokens: 120_000,
  seatCount: 4,
});
assert.equal(bigCouncil.needsConfirm, true);
assert.match(bigCouncil.confirmReason, /5 provider calls/);

// Fan-out at max effort is the most expensive thing the app can do.
const maxEffortCouncil = estimateTurnCost({
  chatMode: "council",
  contextTokens: 20_000,
  reasoningEffort: "max",
  seatCount: 3,
});
assert.equal(maxEffortCouncil.needsConfirm, true);
assert.match(maxEffortCouncil.confirmReason, /most expensive turn/);

// Max effort on an ordinary single-model turn is not, by itself, a reason to ask.
assert.equal(
  estimateTurnCost({
    chatMode: "normal",
    contextTokens: 20_000,
    reasoningEffort: "max",
  }).needsConfirm,
  false,
);

// A send that dwarfs what this chat has been spending gets flagged from history.
const outsized = estimateTurnCost({
  chatMode: "normal",
  contextTokens: 200_000,
  sessionTotals: totals({ calls: 6, totalTokens: 120_000 }),
});
assert.equal(outsized.needsConfirm, true);
assert.match(outsized.confirmReason, /10× what a call in this chat/);

// Without enough history there is no baseline, so a modest turn stays quiet.
assert.equal(
  estimateTurnCost({
    chatMode: "normal",
    contextTokens: 60_000,
    sessionTotals: totals({ calls: 1, totalTokens: 1_000 }),
  }).needsConfirm,
  false,
);

// Nothing to say when nothing is wrong.
assert.equal(summarizeUsageSafety(undefined), undefined);
assert.equal(
  summarizeUsageSafety({ pause: { active: false, scope: "all" }, budgets: [] }),
  undefined,
);

// A budget pause says which provider ran out and when it lifts by itself.
const budgetPause = summarizeUsageSafety({
  pause: {
    active: true,
    scope: "all",
    reason: { kind: "budgetExhausted", providerId: "anthropic" },
    autoResumeAt: "2026-07-28T23:30:00.000Z",
  },
  budgets: [],
});
assert.equal(budgetPause.tone, "paused");
assert.match(budgetPause.title, /anthropic budget is spent/);
assert.match(budgetPause.detail, /resume on their own/);
assert.equal(budgetPause.canResume, true);

// An automations pause makes clear that chat is unaffected.
assert.match(
  summarizeUsageSafety({
    pause: { active: true, scope: "automations", reason: { kind: "manual" } },
    budgets: [],
  }).title,
  /Chat still runs/,
);

// A pause outranks a budget warning: say why work stopped, not everything.
const paused = summarizeUsageSafety({
  pause: { active: true, scope: "all", reason: { kind: "manual" } },
  budgets: [
    {
      providerId: "openai",
      usedTokens: 95,
      maxTokens: 100,
      percent: 95,
      level: "throttle",
      windowHours: 24,
      windowResetsAt: "2026-07-29T00:00:00.000Z",
      hasEstimates: false,
    },
  ],
});
assert.equal(paused.tone, "paused");
assert.equal(paused.title, "Gyro is paused.");

// Otherwise the worst budget leads, and a throttle explains what still works.
const throttled = summarizeUsageSafety({
  pause: { active: false, scope: "all" },
  budgets: [
    {
      providerId: "openai",
      usedTokens: 750_000,
      maxTokens: 1_000_000,
      percent: 75,
      level: "notify",
      windowHours: 24,
      windowResetsAt: "2026-07-29T00:00:00.000Z",
      hasEstimates: false,
    },
    {
      providerId: "anthropic",
      usedTokens: 940_000,
      maxTokens: 1_000_000,
      percent: 94,
      level: "throttle",
      windowHours: 24,
      windowResetsAt: "2026-07-29T00:00:00.000Z",
      hasEstimates: true,
    },
  ],
});
assert.equal(throttled.tone, "warning");
assert.match(throttled.title, /anthropic: 94% of budget used/);
assert.match(throttled.title, /partly estimated/);
assert.match(throttled.detail, /Ordinary turns still work/);
assert.equal(throttled.canResume, false);

// Window set is provider-shaped: xAI weekly only; Anthropic/OpenAI 5h+week.
// Percent is local spend vs the daily reference (or a configured budget).
assert.deepEqual(ledgerWindows(undefined), []);

const windows = ledgerWindows({
  providerId: "xai",
  dailyReferenceTokens: 2_000_000,
  fiveHour: totals({
    calls: 3,
    estimatedCalls: 3,
    totalTokens: 500_000,
  }),
  week: totals({
    calls: 9,
    measuredCalls: 9,
    totalTokens: 1_400_000,
    byOrigin: [
      { origin: "chat", label: "Chat", calls: 6, totalTokens: 1_000_000 },
      {
        origin: "automation",
        label: "Automations",
        calls: 3,
        totalTokens: 400_000,
      },
    ],
  }),
});
assert.equal(windows.length, 1);
assert.equal(windows[0].id, "week");
// The week scales the daily reference (2M × 7).
assert.equal(windows[0].detail, "1.4M of 14M");
assert.equal(windows[0].percentLabel, "10%");
assert.equal(windows[0].hasBudget, false);
assert.equal(windows[0].isEstimated, false);
// Origin bars are relative to the biggest spender, not to the window total.
assert.equal(windows[0].origins[0].share, 100);
assert.equal(windows[0].origins[1].share, 40);

// Anthropic keeps 5-hour + weekly; a budget scales into each window length.
const budgeted = ledgerWindows({
  providerId: "anthropic",
  dailyReferenceTokens: 2_000_000,
  fiveHour: totals({ calls: 4, totalTokens: 187_500 }),
  week: totals({ calls: 20, totalTokens: 2_000_000 }),
  budget: {
    providerId: "anthropic",
    usedTokens: 187_500,
    maxTokens: 1_000_000,
    percent: 90,
    level: "throttle",
    windowHours: 24,
    windowResetsAt: "2026-07-30T00:00:00.000Z",
    hasEstimates: false,
  },
});
assert.equal(budgeted.length, 2);
assert.equal(budgeted[0].id, "five-hour");
assert.equal(budgeted[0].hasBudget, true);
// 1M daily budget × 5/24 ≈ 208K; 187.5K is ~90%.
assert.equal(budgeted[0].percentLabel, "90%");
assert.equal(budgeted[0].detail, "188K of 208K");
assert.equal(budgeted[1].id, "week");
assert.equal(budgeted[1].hasBudget, true);
assert.equal(budgeted[1].detail, "2M of 7M");
assert.equal(budgeted[1].percentLabel, "29%");

// xAI-style weekly only: tiny spend reads as <1%; huge spend caps at 100%.
const tiny = ledgerWindows({
  providerId: "kimi",
  dailyReferenceTokens: 2_000_000,
  fiveHour: totals({ calls: 1, totalTokens: 400 }),
  week: totals({ calls: 1, totalTokens: 400 }),
});
assert.equal(tiny.length, 1);
assert.equal(tiny[0].percentLabel, "<1%");

const saturated = ledgerWindows({
  providerId: "kimi",
  dailyReferenceTokens: 2_000_000,
  fiveHour: totals(),
  week: totals({ calls: 400, totalTokens: 99_000_000 }),
});
assert.equal(saturated[0].percent, 100);

// An idle provider reads 0%, not a blank card (weekly reference = 2M × 7).
const idle = ledgerWindows({
  providerId: "gemini",
  dailyReferenceTokens: 2_000_000,
  fiveHour: totals(),
  week: totals(),
});
assert.equal(idle[0].percentLabel, "0%");
assert.equal(idle[0].detail, "0 of 14M");
assert.deepEqual(idle[0].origins, []);

console.log("usage ledger checks passed");
