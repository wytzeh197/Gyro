import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const load = (name) =>
  import(
    pathToFileURL(
      resolve(process.env.GYRO_VERIFY_WORKSPACE, "packages/ui/src", name),
    )
  );
const { turnTokensFromValue: parse, turnTokensLabel: label } =
  await load("turn-tokens.ts");
const { summarizeSessionCost: summarize } = await load("usage-ledger.ts");
const accounting = (overrides = {}) => ({
  source: "provider",
  scope: "turn",
  coverage: "complete",
  known: {
    input: true,
    output: true,
    cacheRead: false,
    cacheWrite: false,
    reasoning: false,
  },
  ...overrides,
});
const turn = (overrides = {}) => ({
  inputTokens: 120,
  outputTokens: 30,
  totalTokens: 150,
  accounting: accounting(),
  ...overrides,
});
const session = (overrides = {}) => ({
  calls: 2,
  measuredCalls: 2,
  estimatedCalls: 0,
  partialCalls: 0,
  unavailableCalls: 0,
  inputTokens: 160,
  outputTokens: 20,
  totalTokens: 180,
  cachedInputTokens: 0,
  byOrigin: [],
  ...overrides,
});

test("estimated turn counts are never presented as provider usage", () => {
  for (const source of ["character-estimate", "mixed", "legacy"]) {
    assert.equal(
      label(parse(turn({ accounting: accounting({ source }) }))),
      "Usage unavailable",
    );
  }
});
test("complete turns stay exact and request or partial readings are lower bounds", () => {
  assert.equal(label(parse(turn())), "150 tokens");
  assert.equal(
    label(parse(turn({ accounting: accounting({ scope: "request" }) }))),
    "≥150 tokens",
  );
  assert.equal(
    label(parse(turn({ accounting: accounting({ coverage: "partial" }) }))),
    "≥150 tokens",
  );
  assert.equal(
    label(parse(turn({ accounting: accounting({ scope: "context" }) }))),
    "Usage unavailable",
  );
});
test("contradictory totals are not displayed as measured", () => {
  assert.equal(label(parse(turn({ totalTokens: 999 }))), "Usage unavailable");
  assert.equal(
    label(parse(turn({ cachedInputTokens: 121 }))),
    "Usage unavailable",
  );
  assert.equal(parse(turn({ inputTokens: -1 })), undefined);
});
test("cache and reasoning subsets do not inflate inclusive totals", () => {
  const reading = parse(
    turn({
      cachedInputTokens: 90,
      cacheWriteTokens: 20,
      reasoningOutputTokens: 10,
    }),
  );
  assert.equal(reading.totalTokens, 150);
  assert.equal(label(reading), "150 tokens");
});
test("measured zero is a valid complete reading", () => {
  assert.equal(
    label(parse(turn({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }))),
    "0 tokens",
  );
});
test("mixed session uses only the reported subtotal as a lower bound", () => {
  const value = summarize(
    session({
      measuredCalls: 1,
      estimatedCalls: 1,
      totalTokens: 9_999,
      reportedTotalTokens: 120,
      cachedInputTokens: 150,
    }),
  );
  assert.equal(value.label, "≥120 tokens · 2 calls");
  assert.equal(value.cachedNote, undefined);
  assert.equal(value.estimateNote, "incomplete coverage");
});
test("unknown session totals stay unavailable without a reported subtotal", () => {
  assert.equal(
    summarize(session({ measuredCalls: 1, estimatedCalls: 1 })).label,
    "Usage unavailable · 2 calls",
  );
  assert.equal(
    summarize(session({ measuredCalls: 1 })).label,
    "Usage unavailable · 2 calls",
  );
});
test("complete session counts remain visible", () => {
  assert.equal(summarize(session()).label, "180 tokens · 2 calls");
  assert.equal(summarize(session({ calls: 0 })).isEmpty, true);
});
test("partial and unavailable calls preserve a reported zero lower bound", () => {
  const value = summarize(
    session({
      measuredCalls: 0,
      partialCalls: 1,
      unavailableCalls: 1,
      reportedTotalTokens: 0,
    }),
  );
  assert.equal(value.label, "≥0 tokens · 2 calls");
  assert.equal(value.isEmpty, false);
});
