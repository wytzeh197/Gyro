import assert from "node:assert/strict";

import {
  formatTokenCount,
  turnTokenReadingForResponse,
  turnTokensDetail,
  turnTokensFromValue,
  turnTokensLabel,
} from "../packages/ui/src/turn-tokens.ts";

// A provider that reports both halves and the total is read straight through.
const reported = turnTokensFromValue({
  inputTokens: 1_200,
  outputTokens: 340,
  totalTokens: 1_540,
});
assert.deepEqual(reported, {
  inputTokens: 1_200,
  outputTokens: 340,
  totalTokens: 1_540,
});

// Preserve a provider's larger reported total when its breakdown is incomplete.
// Cached input and reasoning are subsets; never add them to the total again.
assert.equal(
  turnTokensFromValue({ inputTokens: 10, outputTokens: 10, totalTokens: 999 })
    ?.totalTokens,
  999,
);

// An endpoint that omits the total still renders, or the count would silently
// vanish for a whole provider.
assert.equal(
  turnTokensFromValue({ inputTokens: 100, outputTokens: 25 })?.totalTokens,
  125,
);

// Nothing to show beats showing a wrong number: a turn with no usable reading
// must produce no reading at all rather than a zero the user would read as free.
for (const value of [
  undefined,
  null,
  "1540",
  [],
  {},
  { inputTokens: 100 },
  { totalTokens: -5 },
  { totalTokens: Number.NaN },
  { totalTokens: Number.POSITIVE_INFINITY },
]) {
  assert.equal(
    turnTokensFromValue(value),
    undefined,
    `expected no reading for ${JSON.stringify(value) ?? "undefined"}`,
  );
}

// Zero is a real answer — a cancelled turn that billed nothing — and must not be
// mistaken for a missing one.
assert.deepEqual(turnTokensFromValue({ totalTokens: 0 }), {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: 0,
});

// Below ten thousand every digit still reads as a number; past it the exact
// figure stops carrying information and the grouping takes over.
assert.equal(formatTokenCount(0), "0");
assert.equal(formatTokenCount(9_999), (9_999).toLocaleString());
assert.equal(formatTokenCount(12_400), "12.4k");
assert.equal(formatTokenCount(128_000), "128k");
assert.equal(formatTokenCount(2_400_000), "2.4M");

assert.equal(turnTokensLabel({ totalTokens: 1_540 }), "1,540 tokens");
assert.equal(turnTokensLabel({ totalTokens: 12_400 }), "12.4k tokens");

// The hover has to explain the headline, so it carries the breakdown the
// rounded label drops.
assert.match(
  turnTokensDetail({
    inputTokens: 1_200,
    outputTokens: 340,
    totalTokens: 1_540,
  }),
  /1,540 tokens reported for this turn · 1,200 input · 340 output/,
);
assert.match(
  turnTokensDetail({ totalTokens: 1_540 }),
  /1,540 tokens reported for this turn/,
);

const estimated = turnTokensFromValue({
  inputTokens: 100,
  outputTokens: 25,
  totalTokens: 125,
  measured: false,
});
assert.equal(estimated?.measured, false);
assert.equal(
  turnTokenReadingForResponse(estimated, undefined, "prompt", "answer").label,
  "~125 tokens",
);
assert.equal(
  turnTokenReadingForResponse(reported, undefined, "prompt", "answer").label,
  "1,540 tokens",
);
const oldResponse = turnTokenReadingForResponse(
  undefined,
  { totalTokens: 1_200 },
  "prompt",
  "answer",
);
assert.equal(oldResponse.label, "≥1,200 tokens");
assert.match(oldResponse.title, /last request/);
const withoutUsage = turnTokenReadingForResponse(
  undefined,
  undefined,
  "12345678",
  "1234",
);
assert.equal(withoutUsage.label, "Usage unavailable");
assert.match(withoutUsage.title, /No reliable token usage/);

// The screenshot's verified turn: cached input is a subset, never added twice.
const actual = turnTokensFromValue({
  inputTokens: 3_879_281,
  cachedInputTokens: 3_749_120,
  outputTokens: 15_708,
  reasoningOutputTokens: 2_825,
  totalTokens: 3_894_989,
  measured: false,
});
const reading = turnTokenReadingForResponse(actual, undefined, "", "");
assert.equal(reading.label, "~3.9M tokens · 3.7M cached");
assert.match(reading.title, /3,894,989 tokens/);
assert.match(reading.title, /3,749,120 cached input/);
assert.match(reading.title, /not additional/);
assert.match(reading.title, /2,825 reasoning/);
assert.equal(
  turnTokensLabel(actual),
  "~3.9M tokens",
  "live estimate remains labelled",
);
assert.equal(
  turnTokenReadingForResponse(
    undefined,
    { totalTokens: 100, measured: false },
    "",
    "",
  ).label,
  "~100 tokens",
  "estimated context is not a measured lower bound",
);

for (const value of [
  { totalTokens: 1.5 },
  { totalTokens: Number.MAX_SAFE_INTEGER + 1 },
  { totalTokens: 5, inputTokens: -1 },
  { totalTokens: 5, outputTokens: "5" },
  { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
])
  assert.equal(turnTokensFromValue(value), undefined);
assert.deepEqual(
  turnTokensFromValue({ inputTokens: 100, outputTokens: 20, totalTokens: 0 }),
  {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    measured: false,
  },
);
assert.equal(
  turnTokensFromValue({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 999,
    reasoningOutputTokens: 999,
    totalTokens: 120,
  }).cachedInputTokens,
  100,
);
assert.equal(
  turnTokensFromValue({
    inputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 999,
    totalTokens: 120,
  }).reasoningOutputTokens,
  20,
);
assert.equal(formatTokenCount(999_999), "1.0M");
assert.equal(formatTokenCount(NaN), "—");
assert.equal(formatTokenCount(-1), "—");
// Persist and reload preserves confidence and breakdown exactly.
assert.deepEqual(
  turnTokensFromValue(JSON.parse(JSON.stringify(actual))),
  actual,
);

// A total-only backend reading must not claim a known zero input/output split.
assert.doesNotMatch(
  turnTokensDetail({ inputTokens: 0, outputTokens: 0, totalTokens: 150, measured: true }),
  /0 input|0 output/,
);
assert.match(
  turnTokensDetail({ inputTokens: 0, outputTokens: 0, totalTokens: 0, measured: true }),
  /0 input · 0 output/,
);

console.log("turn token checks passed");
