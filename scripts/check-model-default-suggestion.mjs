import assert from "node:assert/strict";
import {
  MODEL_DEFAULT_SUGGESTION_MAX_STORAGE_CHARS,
  createModelDefaultSuggestionState,
  dismissModelDefaultSuggestion,
  isSuccessfulModelUseResponse,
  markModelDefaultSuggestionShown,
  modelDefaultSuggestionFor,
  modelDefaultSuggestionKey,
  parseModelDefaultSuggestionState,
  recordCompletedModelUse,
  snoozeProviderDefaultSuggestions,
} from "../apps/desktop/src/model-default-suggestion.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-31T12:00:00Z");
const MODEL = { providerId: "openai", modelId: "gpt-6-astra" };
const options = {
  ...MODEL,
  available: true,
  defaultModelId: "gpt-6-sol",
  shownThisLaunch: false,
  now: NOW,
};
const eligible = (state, changes = {}) =>
  modelDefaultSuggestionFor(state, { ...options, ...changes });
const use = (index, changes = {}) => ({
  ...MODEL,
  sessionId: `chat-${index % 3}`,
  turnId: `turn-${index}`,
  completedAt: NOW - (index < 2 ? DAY : 0),
  ...changes,
});
function history(count = 5, overrides = () => ({}), now = NOW) {
  return Array.from({ length: count }, (_, i) => use(i, overrides(i))).reduce(
    (state, value) => recordCompletedModelUse(state, value, now),
    createModelDefaultSuggestionState(),
  );
}

assert.deepEqual(eligible(history()), {
  ...MODEL,
  usageCount: 5,
  chatCount: 3,
  dayCount: 2,
});
assert.equal(
  eligible(history(4)),
  undefined,
  "four successful turns are not enough",
);
assert.equal(
  eligible(history(10, () => ({ sessionId: "same-chat" }))),
  undefined,
  "one long thread does not establish a default preference",
);
assert.equal(
  eligible(history(10, (i) => ({ sessionId: `chat-${i % 2}` }))),
  undefined,
  "at least three different chats are required",
);
assert.equal(
  eligible(history(10, () => ({ completedAt: NOW }))),
  undefined,
  "one day of experimentation is not a repeated preference",
);
assert.equal(
  eligible(history(), { available: false }),
  undefined,
  "removed or unavailable models cannot be suggested",
);
assert.equal(
  eligible(history(), { defaultModelId: MODEL.modelId }),
  undefined,
  "never suggest the model that is already the effective default",
);
assert.ok(
  eligible(history(), { defaultModelId: "another-default" }),
  "current default, not a permanent historical standard flag, controls eligibility",
);
assert.equal(eligible(history(), { shownThisLaunch: true }), undefined);
assert.equal(
  eligible(history(), { providerId: "other-provider" }),
  undefined,
  "the same model ID on another provider is separate evidence",
);
assert.equal(eligible(history(), { modelId: "another-model" }), undefined);

const baseline = history();
const original = JSON.stringify(baseline);
const replayed = recordCompletedModelUse(
  baseline,
  use(0, {
    modelId: "different-model",
    completedAt: NOW,
  }),
  NOW,
);
assert.equal(
  replayed.uses.length,
  5,
  "retry/replayed completion never counts twice",
);
assert.deepEqual(eligible(replayed), eligible(baseline));
assert.equal(
  JSON.stringify(baseline),
  original,
  "recording never mutates caller state",
);
const filtered = recordCompletedModelUse(
  baseline,
  use(99, { completedAt: NOW + 1 }),
  NOW,
);
assert.equal(filtered.uses.length, 5, "future evidence is not trusted");
assert.equal(
  eligible(history(5, (i) => ({ completedAt: NOW - (31 + i) * DAY }))),
  undefined,
);
assert.equal(
  eligible(history(), { now: NOW + 31 * DAY }),
  undefined,
  "old successful uses expire instead of accumulating forever",
);

const response = {
  assistantEvent: { kind: "assistant-message" },
  statusEvent: { payload: { status: "done" } },
};
assert.equal(isSuccessfulModelUseResponse(response), true);
for (const status of [
  "failed",
  "cancelled",
  "running",
  "waiting",
  "queued",
  undefined,
]) {
  assert.equal(
    isSuccessfulModelUseResponse({
      ...response,
      statusEvent: { payload: { status } },
    }),
    false,
  );
}
for (const value of [
  true,
  false,
  null,
  {},
  { statusEvent: response.statusEvent },
  {
    assistantEvent: { kind: "user-message" },
    statusEvent: response.statusEvent,
  },
]) {
  assert.equal(
    isSuccessfulModelUseResponse(value),
    false,
    "send return values and incomplete responses are not successful usage",
  );
}

const shown = markModelDefaultSuggestionShown(baseline, NOW);
assert.equal(eligible(shown, { now: NOW + 7 * DAY - 1 }), undefined);
assert.ok(
  eligible(shown, { now: NOW + 7 * DAY }),
  "global cooldown expires at seven days",
);
const otherModel = { providerId: "anthropic", modelId: "claude-opus-5" };
const withOther = Array.from({ length: 5 }, (_, i) =>
  use(i, { ...otherModel, turnId: `other-${i}` }),
).reduce((state, value) => recordCompletedModelUse(state, value, NOW), shown);
assert.equal(
  eligible(withOther, { ...otherModel }),
  undefined,
  "showing one suggestion prevents another model from immediately nagging",
);

const dismissed = dismissModelDefaultSuggestion(shown, MODEL, NOW);
assert.equal(eligible(dismissed, { now: NOW + 7 * DAY }), undefined);
const nearEnd = NOW + 30 * DAY - 1;
const recent = Array.from({ length: 5 }, (_, i) =>
  use(i, {
    turnId: `fresh-${i}`,
    completedAt: nearEnd - (i < 2 ? DAY : 0),
  }),
).reduce(
  (state, value) => recordCompletedModelUse(state, value, nearEnd),
  dismissed,
);
assert.equal(
  eligible(recent, { now: nearEnd }),
  undefined,
  "Not now waits thirty days despite more use",
);
assert.ok(
  eligible(recent, { now: NOW + 30 * DAY }),
  "cooldown expiry still requires recent qualifying evidence",
);

const permanent = dismissModelDefaultSuggestion(
  baseline,
  { ...MODEL, neverSuggestAgain: true },
  NOW,
);
const reloaded = parseModelDefaultSuggestionState(
  JSON.stringify(permanent),
  NOW,
);
assert.equal(
  eligible(reloaded),
  undefined,
  "per-model decline survives reload",
);
const declinedThenSnoozed = dismissModelDefaultSuggestion(reloaded, MODEL, NOW);
assert.equal(
  declinedThenSnoozed.modelDecisions[
    modelDefaultSuggestionKey(MODEL.providerId, MODEL.modelId)
  ].neverSuggestAgain,
  true,
  "a later Not now cannot weaken a permanent decline",
);
const permanentWithOther = Array.from({ length: 5 }, (_, i) =>
  use(i, { ...otherModel, turnId: `other-${i}` }),
).reduce(
  (state, value) => recordCompletedModelUse(state, value, NOW),
  permanent,
);
assert.ok(
  eligible(permanentWithOther, { ...otherModel }),
  "permanent decline applies only to that model",
);

const manual = snoozeProviderDefaultSuggestions(
  baseline,
  MODEL.providerId,
  NOW,
);
assert.equal(
  eligible(manual, { now: NOW + 7 * DAY }),
  undefined,
  "an explicit Settings default choice suppresses suggestions for that provider",
);
const manualWithOther = Array.from({ length: 5 }, (_, i) =>
  use(i, { ...otherModel, turnId: `other-${i}` }),
).reduce((state, value) => recordCompletedModelUse(state, value, NOW), manual);
assert.ok(
  eligible(manualWithOther, { ...otherModel }),
  "manual choice does not suppress unrelated providers",
);

for (const raw of [
  null,
  "",
  "broken",
  "null",
  "[]",
  '{"version":99}',
  '{"openai:gpt-6-astra":{"count":900,"standard":true}}',
]) {
  assert.deepEqual(
    parseModelDefaultSuggestionState(raw, NOW),
    createModelDefaultSuggestionState(),
    "invalid or legacy picker history must not manufacture completed use",
  );
}
assert.deepEqual(
  parseModelDefaultSuggestionState(
    "x".repeat(MODEL_DEFAULT_SUGGESTION_MAX_STORAGE_CHARS + 1),
    NOW,
  ),
  createModelDefaultSuggestionState(),
);
const tampered = parseModelDefaultSuggestionState(
  JSON.stringify({
    ...baseline,
    uses: [
      ...baseline.uses,
      use(0),
      use(20, { completedAt: -1 }),
      use(21, { completedAt: NOW + 1 }),
      use(22, { modelId: "" }),
    ],
    modelDecisions: {
      nonsense: { neverSuggestAgain: true },
      [modelDefaultSuggestionKey("valid", "model")]: {
        neverSuggestAgain: "true",
      },
    },
    providerCooldowns: { openai: "forever" },
    lastShownAt: "today",
  }),
  NOW,
);
assert.deepEqual(
  tampered,
  baseline,
  "parser strips invalid fields, duplicate evidence, and malformed decisions",
);
assert.deepEqual(
  parseModelDefaultSuggestionState(JSON.stringify(baseline), NOW),
  baseline,
);
assert.notEqual(
  modelDefaultSuggestionKey("provider:model", "id"),
  modelDefaultSuggestionKey("provider", "model:id"),
  "provider/model IDs cannot collide on separator characters",
);

const permanentChoices = Object.fromEntries([
  [
    modelDefaultSuggestionKey(MODEL.providerId, MODEL.modelId),
    { neverSuggestAgain: true },
  ],
  ...Array.from({ length: 999 }, (_, i) => [
    modelDefaultSuggestionKey("provider", `${"model".repeat(30)}-${i}`),
    { neverSuggestAgain: true },
  ]),
]);
const oversizedEvidence = {
  ...createModelDefaultSuggestionState(),
  modelDecisions: permanentChoices,
  uses: Array.from({ length: 600 }, (_, i) =>
    use(i, {
      providerId: "p".repeat(1_000),
      modelId: "m".repeat(1_000),
      sessionId: "s".repeat(1_000),
      turnId: `${"t".repeat(990)}-${i}`,
    }),
  ),
};
const bounded = recordCompletedModelUse(oversizedEvidence, use(900), NOW);
assert.ok(
  bounded.uses.length <= 512,
  "only a bounded tail of recent uses is retained",
);
assert.ok(
  JSON.stringify(bounded).length <= MODEL_DEFAULT_SUGGESTION_MAX_STORAGE_CHARS,
);
const boundedReload = parseModelDefaultSuggestionState(
  JSON.stringify(bounded),
  NOW,
);
assert.deepEqual(
  boundedReload.modelDecisions,
  permanentChoices,
  "storage budgeting discards usage evidence before explicit permanent choices",
);

console.log("model default suggestion policy: passed");
