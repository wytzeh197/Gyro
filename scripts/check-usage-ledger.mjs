import assert from "node:assert/strict";

import {
  estimateTurnCost,
  formatTokenCount,
  isOutsizedTurn,
  summarizeSessionCost,
  summarizeUsageSafety,
} from "../packages/ui/src/usage-ledger.ts";

function totals(overrides = {}) {
  return {
    calls: 0,
    measuredCalls: 0,
    estimatedCalls: 0,
    inputTokens: 0,
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

console.log("usage ledger checks passed");
