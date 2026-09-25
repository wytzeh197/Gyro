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

// A reported total stands even when it disagrees with the two halves: the
// endpoint knows what it billed, and cached or reasoning tokens are exactly the
// kind of thing that makes input + output an incomplete sum.
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
assert.equal(
  turnTokensDetail({
    inputTokens: 1_200,
    outputTokens: 340,
    totalTokens: 1_540,
  }),
  "1,540 tokens billed this turn · 1,200 in, 340 out",
);
assert.equal(
  turnTokensDetail({ totalTokens: 1_540 }),
  "1,540 tokens billed this turn",
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
assert.equal(withoutUsage.label, "~3 tokens");
assert.match(withoutUsage.title, /not included/);

console.log("turn token checks passed");
