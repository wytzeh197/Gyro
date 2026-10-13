import assert from "node:assert/strict";
import { formatCompactTokenCount } from "../packages/ui/src/token-count.ts";
import { formatTokenCount as ledgerTokenCount } from "../packages/ui/src/usage-ledger.ts";
import { estimateComposerContextUsage } from "../packages/ui/src/context-usage.ts";
import { formatTokenCount, turnTokenReadingForResponse, turnTokensDetail, turnTokensFromValue, turnTokensLabel } from "../packages/ui/src/turn-tokens.ts";

const metadata = (coverage = "complete", overrides = {}) => ({
  source: "provider", scope: "turn", coverage,
  known: { input: true, output: true, cacheRead: false, cacheWrite: false, reasoning: false },
  ...overrides,
});
const reported = turnTokensFromValue({
  inputTokens: 1200, outputTokens: 340, totalTokens: 1540, measured: true,
  accounting: metadata(),
});
assert.equal(reported.totalTokens, 1540);
assert.equal(turnTokensLabel(reported), "1,540 tokens");
assert.match(turnTokensDetail(reported), /1,540 tokens reported for this turn · 1,200 input · 340 output/);
assert.equal(turnTokenReadingForResponse(reported, undefined, "", "").label, "1,540 tokens");

const partial = turnTokensFromValue({ ...reported, measured: false,
  accounting: metadata("partial", { reason: "missing-baseline" }) });
assert.equal(turnTokensLabel(partial), "≥1,540 tokens");
assert.match(turnTokensDetail(partial), /verified starting count/);
const estimated = turnTokensFromValue({ inputTokens: 100, outputTokens: 25, totalTokens: 125, measured: false,
  accounting: metadata("estimated", { source: "character-estimate", reason: "missing-usage" }) });
assert.equal(turnTokensLabel(estimated), "~125 tokens");
assert.match(turnTokensDetail(estimated), /observed text/);
const unavailable = turnTokensFromValue({ totalTokens: 0, measured: false,
  accounting: metadata("unavailable", { reason: "unsupported-runtime" }) });
assert.equal(turnTokensLabel(unavailable), "Usage unavailable");
assert.doesNotMatch(turnTokensDetail(unavailable), /0 tokens/);
assert.equal(turnTokenReadingForResponse(undefined, undefined, "12345678", "1234").label, "Usage unavailable");

// No provenance: retain old counts, but don't silently upgrade their confidence.
const legacy = turnTokensFromValue({ inputTokens: 1200, outputTokens: 340, totalTokens: 1540 });
assert.equal(legacy.totalTokens, 1540);
assert.equal(turnTokensLabel(legacy), "Usage unavailable");
assert.equal(turnTokensLabel({ totalTokens: 125, measured: false }), "~125 tokens");
// Old context payloads are not known request usage.
assert.equal(turnTokenReadingForResponse(undefined, { totalTokens: 1200 }, "", "").label, "Usage unavailable");
for (const scope of ["context", "session"]) {
  const occupancy = turnTokensFromValue({ ...reported, accounting: metadata("complete", { scope }) });
  assert.equal(turnTokenReadingForResponse(occupancy, undefined, "", "").label, "Usage unavailable");
}
const request = turnTokensFromValue({ ...reported, accounting: metadata("complete", { scope: "request" }) });
assert.equal(turnTokenReadingForResponse(undefined, request, "", "").label, "≥1,540 tokens");

// Caches and reasoning are subsets after provider-specific normalization.
const actual = turnTokensFromValue({
  inputTokens: 3879281, cachedInputTokens: 3749120, cacheWriteTokens: 100,
  outputTokens: 15708, reasoningOutputTokens: 2825, totalTokens: 3894989, measured: true,
  accounting: metadata("complete", { scope: "task", known: {
    input: true, output: true, cacheRead: true, cacheWrite: true, reasoning: true } }),
});
const reading = turnTokenReadingForResponse(actual, undefined, "", "");
assert.equal(reading.label, "3.89M tokens · includes 3.75M cached");
assert.match(reading.title, /3,894,989 tokens/);
assert.match(reading.title, /not additional/);
assert.match(reading.title, /100 cache-write/);
assert.match(reading.title, /2,825 reasoning/);
assert.deepEqual(turnTokensFromValue(JSON.parse(JSON.stringify(actual))), actual);

// The screenshot's two rounded 1.8M values are distinct; cache is part of total.
const screenshot = turnTokensFromValue({
  inputTokens: 1834057, cachedInputTokens: 1786368, outputTokens: 3120,
  totalTokens: 1837177, measured: true,
  accounting: metadata("complete", { known: {
    input: true, output: true, cacheRead: true, cacheWrite: false, reasoning: false } }),
});
const screenshotReading = turnTokenReadingForResponse(screenshot, undefined, "", "");
assert.equal(screenshot.totalTokens, screenshot.inputTokens + screenshot.outputTokens);
assert.equal(screenshotReading.label, "1.84M tokens · includes 1.79M cached");
assert.match(screenshotReading.title, /1,837,177 tokens reported/);
assert.match(screenshotReading.title, /1,834,057 input · 3,120 output/);
assert.match(screenshotReading.title, /Includes 1,786,368 cached input tokens, already part of input, not additional tokens/);

// Actual reported zero differs from missing halves represented as zero internally.
const zero = turnTokensFromValue({ inputTokens: 0, outputTokens: 0, totalTokens: 0, measured: true, accounting: metadata() });
assert.equal(turnTokensLabel(zero), "0 tokens");
assert.match(turnTokensDetail(zero), /0 input · 0 output/);
const totalOnly = turnTokensFromValue({ inputTokens: 0, outputTokens: 0, totalTokens: 150, measured: true,
  accounting: metadata("complete", { known: { input: false, output: false, cacheRead: false, cacheWrite: false, reasoning: false } }) });
assert.doesNotMatch(turnTokensDetail(totalOnly), /0 input|0 output/);
assert.equal(turnTokensLabel(totalOnly), "150 tokens");
const demoted = turnTokensFromValue({ ...reported, measured: false });
assert.equal(turnTokensLabel(demoted), "≥1,540 tokens");

// Contradictory provider totals remain visible only as uncertain readings.
const conflict = turnTokensFromValue({ inputTokens: 100, outputTokens: 20, totalTokens: 0, measured: true, accounting: metadata() });
assert.equal(conflict.totalTokens, 120);
assert.equal(turnTokensLabel(conflict), "~120 tokens");
assert.match(turnTokensDetail(conflict), /inconsistent/);
assert.equal(turnTokensFromValue({ inputTokens: 100, outputTokens: 25 }).totalTokens, 125);
assert.equal(turnTokensFromValue({ inputTokens: 10, outputTokens: 10, totalTokens: 999 }).totalTokens, 999);
const inflated = turnTokensFromValue({ inputTokens: 10, outputTokens: 10, totalTokens: 999,
  measured: true, accounting: metadata() });
assert.equal(inflated.measured, false);
assert.equal(turnTokensLabel(inflated), "~999 tokens");
assert.match(turnTokensDetail(inflated), /inconsistent/);
const absentKnownInput = turnTokensFromValue({ outputTokens: 10, totalTokens: 120,
  measured: true, accounting: metadata() });
assert.equal(absentKnownInput.accounting.coverage, "estimated");
for (const value of [undefined, null, "1540", [], {}, { inputTokens: 100 },
  { totalTokens: -5 }, { totalTokens: NaN }, { totalTokens: Infinity }, { totalTokens: 1.5 },
  { totalTokens: Number.MAX_SAFE_INTEGER + 1 }, { totalTokens: 5, outputTokens: "5" },
  { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
  { totalTokens: 5, accounting: { ...metadata(), coverage: "exact" } },
  { totalTokens: 5, accounting: { ...metadata(), known: { input: "yes" } } },
]) assert.equal(turnTokensFromValue(value), undefined);
assert.equal(turnTokensFromValue({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 999,
  reasoningOutputTokens: 999, totalTokens: 120 }).cachedInputTokens, 100);
for (const invalidSubset of [
  { cachedInputTokens: 101 },
  { cacheWriteTokens: 101 },
  { cachedInputTokens: 80, cacheWriteTokens: 21 },
  { reasoningOutputTokens: 21 },
]) {
  const tokens = turnTokensFromValue({ inputTokens: 100, outputTokens: 20, totalTokens: 120,
    measured: true, accounting: metadata("complete", { known: {
      input: true, output: true, cacheRead: true, cacheWrite: true, reasoning: true } }),
    ...invalidSubset });
  assert.equal(tokens.measured, false);
  assert.equal(tokens.accounting.coverage, "estimated");
  assert.equal(tokens.accounting.reason, "inconsistent-counts");
  assert.equal(turnTokensLabel(tokens), "~120 tokens");
  assert.match(turnTokensDetail(tokens), /inconsistent/);
}
const unavailableConflict = turnTokensFromValue({ inputTokens: 100, outputTokens: 20,
  cachedInputTokens: 101, totalTokens: 120, measured: false,
  accounting: metadata("unavailable", { reason: "unverified-runtime" }) });
assert.equal(turnTokensLabel(unavailableConflict), "Usage unavailable");
assert.equal(unavailableConflict.accounting.coverage, "unavailable");
assert.equal(formatTokenCount(0), "0");
assert.equal(formatTokenCount(9999), (9999).toLocaleString());
assert.equal(formatTokenCount(12400), "12.4K");
assert.equal(formatTokenCount(128000), "128K");
assert.equal(formatTokenCount(999999), "1M");
assert.equal(formatTokenCount(2400000), "2.4M");
assert.equal(formatTokenCount(1837177), "1.84M");
assert.equal(formatTokenCount(9_910_000), "9.91M");
assert.equal(formatTokenCount(13_980_000), "13.98M");
assert.equal(formatTokenCount(5_020_000), "5.02M");
assert.equal(formatTokenCount(1786368), "1.79M");
assert.equal(formatTokenCount(NaN), "—");
assert.equal(formatTokenCount(-1), "—");
// Identical large counts have identical units and precision in every surface.
for (const count of [10_000, 12_400, 999_499, 999_500, 5_020_000, 9_910_000, 13_980_000]) {
  const context = estimateComposerContextUsage([{ id: "usage", sessionId: "fixture", kind: "assistant-message",
    createdAt: "2026-10-13T00:00:00Z", message: "", payload: { providerId: "openai", modelId: "fixture",
      contextUsage: { inputTokens: count, outputTokens: 0, totalTokens: count } } }], "",
    { providerId: "openai", modelId: "fixture", contextWindowTokens: 20_000_000 });
  assert.equal(context.source, "reported");
  assert.equal(context.usedLabel, ledgerTokenCount(count));
  assert.equal(formatTokenCount(count), formatCompactTokenCount(count));
  assert.equal(context.usedLabel, formatTokenCount(count));
}
console.log("turn token checks passed: complete, partial, estimated, unavailable, legacy, scope, subsets and persistence");
