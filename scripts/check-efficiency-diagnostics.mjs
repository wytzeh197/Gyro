import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  pairedQuality,
  tokenBreakdown,
  failureBreakdown,
} from "./efficiency-diagnostics.mjs";
import {
  prefixPilotPlans,
  describePlan,
  prepare,
} from "./prepare-efficiency-prefix-pilot.mjs";
import { report, markdown } from "./efficiency-report.mjs";

const tokens = {
  inputTokens: 100,
  cachedInputTokens: 60,
  cacheWriteTokens: 10,
  outputTokens: 20,
  reasoningOutputTokens: 5,
  totalTokens: 120,
  measured: true,
  accounting: {
    source: "provider",
    coverage: "complete",
    scope: "task",
    known: {
      input: true,
      output: true,
      cacheRead: true,
      cacheWrite: true,
      reasoning: true,
    },
  },
};
const ok = { outcome: "done", verified: true, tokens };
const failed = { ...ok, outcome: "failed", verified: false };
const sum = tokenBreakdown([ok, failed]);
assert.equal(sum.inputTokens.total, 200, "failed attempts count too");
assert.equal(
  sum.uncachedInputTokens.total,
  60,
  "cache reads and writes are input subsets",
);
assert.equal(sum.outputTokens.total, 40, "reasoning is already in output");
assert.equal(sum.reasoningOutputTokens.total, 10);
assert.equal(tokenBreakdown([]).inputTokens.total, null);
const unknownCache = {
  ...tokens,
  accounting: {
    ...tokens.accounting,
    known: { ...tokens.accounting.known, cacheWrite: false },
  },
};
const mixed = tokenBreakdown([ok, { tokens: unknownCache }]);
assert.equal(mixed.cacheWriteTokens.total, null);
assert.equal(mixed.cacheWriteTokens.observedSubtotal, 10);
assert.equal(mixed.cacheWriteTokens.knownRuns, 1);
assert.equal(
  mixed.uncachedInputTokens.total,
  null,
  "unknown cache writes are not zero",
);
assert.equal(mixed.inputTokens.total, 200);
for (const invalid of [
  null,
  { ...tokens, measured: false },
  { ...tokens, accounting: undefined },
  { ...tokens, accounting: { ...tokens.accounting, coverage: "partial" } },
  { ...tokens, accounting: { ...tokens.accounting, scope: "context" } },
  { ...tokens, inputTokens: -1 },
  { ...tokens, inputTokens: 1.5 },
]) {
  assert.equal(tokenBreakdown([{ tokens: invalid }]).inputTokens.total, null);
}
assert.equal(
  tokenBreakdown([{ tokens: { ...tokens, cachedInputTokens: 95 } }])
    .uncachedInputTokens.total,
  null,
);
assert.equal(
  tokenBreakdown([{ tokens: { ...tokens, reasoningOutputTokens: 30 } }])
    .reasoningOutputTokens.total,
  null,
);
assert.equal(
  tokenBreakdown([
    { tokens: { ...tokens, inputTokens: Number.MAX_SAFE_INTEGER } },
    ok,
  ]).inputTokens.total,
  null,
);
const zero = structuredClone(tokens);
for (const key of [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "reasoningOutputTokens",
  "totalTokens",
])
  zero[key] = 0;
assert.equal(tokenBreakdown([{ tokens: zero }]).uncachedInputTokens.total, 0);

const pairs = [
  [ok, ok],
  [failed, ok],
  [ok, failed],
  [failed, failed],
];
assert.deepEqual(
  Object.values(pairedQuality(pairs, true)).slice(0, 4),
  [1, 1, 1, 1],
);
assert.equal(pairedQuality(pairs, true).successRateChange, 0);
assert.equal(
  pairedQuality(
    [
      [failed, ok],
      [ok, ok],
    ],
    true,
  ).successRateChange,
  0.5,
);
assert.equal(pairedQuality([[failed, ok]], false).successRateChange, null);
const unknownQuality = pairedQuality([[{ outcome: "done" }, ok]], false);
assert.equal(unknownQuality.unknown, 1);
assert.equal(
  unknownQuality.improved,
  0,
  "missing verification is not a measured failure",
);
assert.deepEqual(
  failureBreakdown([
    ok,
    failed,
    { outcome: "done", verified: false },
    { outcome: "done" },
    { outcome: "budget-stop" },
    { outcome: "unavailable", failureDetail: "private" },
  ]),
  {
    executionFailed: 1,
    verificationFailed: 1,
    verificationUnknown: 1,
    budgetStopped: 1,
    unavailable: 1,
  },
);

// Exercise the actual report path, not only helpers.
const base = {
  ...ok,
  task: "a",
  repositorySnapshot: "sha256:" + "a".repeat(64),
  provider: "api",
  model: "m",
  effort: "medium",
  variant: "baseline",
  trial: 1,
  sessionCondition: "fresh-session",
  comparison: "gyro",
  retries: 0,
  generationRequests: 1,
  elapsedMs: 100,
  requestedReasoningEffort: "medium",
  requestedEffortCoverage: "observed",
  estimatedCost: {
    currency: "USD",
    snapshotId: "p",
    estimated: true,
    micros: 100,
  },
};
const spec = {
  schema: "gyro.efficiency-benchmark.v2",
  providers: [{ id: "api", model: "m", effort: "medium" }],
  tasks: [{ id: "a", repositorySnapshot: base.repositorySnapshot }],
  trials: 1,
  variants: ["baseline", "stable-api-prefix"],
  cacheConditions: ["fresh-session"],
};
const candidate = {
  ...base,
  variant: "stable-api-prefix",
  estimatedCost: { ...base.estimatedCost, micros: 70 },
};
const result = report([base, candidate], spec);
assert.equal(
  result.groups[1].gate,
  "pilot-qualified",
  "diagnostics must not loosen existing gates",
);
assert.equal(result.groups[1].pairedQuality.successRateChange, 0);
assert.match(markdown(result), /Paired correctness/);
assert.match(markdown(result), /Uncached input/);
assert.match(markdown(result), /Failure breakdown/);
const incomplete = report([base, candidate, candidate], spec).groups[1];
assert.equal(incomplete.gate, "incomplete");
assert.equal(incomplete.pairedQuality.successRateChange, null);

const plans = prefixPilotPlans();
assert.equal(describePlan(plans.smoke).taskRunsPerProvider, 2);
assert.equal(describePlan(plans.smoke).userPromptsPerProvider, 2);
assert.equal(describePlan(plans.paired).taskRunsPerProvider, 36);
assert.equal(describePlan(plans.paired).userPromptsPerProvider, 114);
assert.equal(plans.paired.tasks.length, 3);
assert.deepEqual(plans.paired.variants, ["baseline", "stable-api-prefix"]);
const directory = await mkdtemp(
  join(tmpdir(), "gyro-prefix-preparation-test-"),
);
try {
  const target = join(directory, "prepared");
  await prepare(target);
  await assert.rejects(prepare(target), { code: "EEXIST" });
  for (const name of ["smoke", "paired"]) {
    const path = join(target, `${name}.json`);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved, plans[name]);
    // The real entry point must refuse both templates before building or generating.
    const rejected = spawnSync(
      process.execPath,
      ["scripts/benchmark-efficiency.mjs", "--spec", path],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(rejected.status, 1);
    assert.match(
      rejected.stderr,
      /selected providers and explicit finite execution limits/,
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Efficiency diagnostics, paired quality, and non-executable prefix pilot preparation passed. No provider calls.",
);
