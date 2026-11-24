import assert from "node:assert/strict";
import { harnessPlans } from "./prepare-efficiency-harness.mjs";
import { report } from "./efficiency-report.mjs";
import { verifyFrozenHoldout } from "./efficiency-holdout.mjs";

assert.equal(verifyFrozenHoldout(), 24);
const plans = harnessPlans();
assert.ok(
  Object.values(plans).every((plan) => plan.executionBudget.maxCalls === 0),
);
assert.ok(
  Object.values(plans).every((plan) =>
    plan.tasks.every((task) => !Object.hasOwn(task, "referenceSolution")),
  ),
);
assert.equal(plans["api-prefix-paired"].trials, 3);

const asReport = ({ spec, attempt }) => {
  const provider = spec.providers[0];
  const records = spec.tasks.flatMap((task, index) =>
    spec.cacheConditions.flatMap((sessionCondition) =>
      spec.variants.map((variant) => {
        const native = Boolean(spec.nativeCliVersion);
        const candidate = variant === "harness-candidate";
        return attempt(
          {
            task: task.id,
            repositorySnapshot: task.repositorySnapshot,
            ...provider,
            provider: provider.id,
            variant,
            sessionCondition,
            trial: 1,
            outcome: "done",
            verified: candidate || index >= 6,
            elapsedMs: candidate ? 90 : 100,
            scopeVerified: true,
            comparison: "gyro",
            checkpointRecoveries: Number(candidate),
            nativeCliVersion: spec.nativeCliVersion,
            gyroToolRequests: 3,
            requestedEffortCoverage: native
              ? "native-launch-configured"
              : "observed",
            requestedReasoningEffort: provider.effort,
            generationRequests: native ? null : 1,
            retries: native ? null : 0,
            tokens: native
              ? null
              : {
                  measured: true,
                  totalTokens: 100,
                  accounting: {
                    source: "provider",
                    coverage: "complete",
                    scope: "task",
                    known: { input: true, output: true },
                  },
                },
            estimatedCost: native
              ? null
              : {
                  currency: "USD",
                  micros: candidate ? 70 : 100,
                  estimated: true,
                  snapshotId: "immutable-prices",
                },
            efficiencyEvents: candidate ? { confirmedPrefixReuses: 1 } : {},
          },
          task,
        );
      }),
    ),
  );
  return report(records, spec).groups.find(
    (group) => group.variant === "harness-candidate",
  );
};

const api = plans["deepseek-holdout"];
const native = {
  ...plans["openai-holdout"],
  nativeCliVersion: "codex-cli test",
};
for (const spec of [api, native]) {
  const qualified = asReport({ spec, attempt: (row) => row });
  assert.equal(qualified.gate, "holdout-qualified");
  assert.equal(qualified.pairs, 48);
  assert.equal(qualified.medianMs, 90);
  assert.equal(qualified.holdoutQuality.delta, 0.25);
  assert.ok(qualified.holdoutQuality.pairedTaskBootstrap95[0] > 0);
  assert.equal(qualified.holdoutQuality.leaveOneSourceRevisionOut.length, 4);
  assert.ok(qualified.holdoutQuality.leaveOneSourceRevisionOut.every(({ delta }) => delta > 0));
  assert.equal(
    qualified.costReduction === null,
    Boolean(spec.nativeCliVersion),
  );

  for (const [reason, mutate] of [
    [
      "out-of-scope edit",
      (row) => {
        row.scopeVerified = false;
      },
    ],
    [
      "budget stop",
      (row) => {
        row.outcome = "budget-stop";
      },
    ],
    [
      "unexercised checkpoint",
      (row) => {
        row.checkpointRecoveries = 0;
      },
    ],
    [
      "slow tail",
      (row) => {
        row.elapsedMs = 120;
      },
    ],
    [
      "effort drift",
      (row) => {
        row.requestedReasoningEffort = "other";
      },
    ],
  ]) {
    const rejected = asReport({
      spec,
      attempt: (row) => {
        if (row.variant === "harness-candidate") mutate(row);
        return row;
      },
    });
    assert.equal(rejected.gate, "holdout-not-qualified", reason);
  }
  const criticalLoss = asReport({
    spec,
    attempt: (row, task) => ({
      ...row,
      verified:
        row.variant === "harness-candidate" && task.critical
          ? false
          : row.verified,
    }),
  });
  assert.equal(criticalLoss.gate, "holdout-not-qualified");

  const sharedRevision = spec.tasks[0].sourceRevisions[0];
  const concentrated = asReport({
    spec,
    attempt: (row, task) => ({
      ...row,
      verified:
        row.variant === "harness-candidate" ||
        !task.sourceRevisions.includes(sharedRevision),
    }),
  });
  assert.ok(concentrated.holdoutQuality.delta >= 0.05);
  assert.ok(concentrated.holdoutQuality.pairedTaskBootstrap95[0] > 0);
  assert.equal(
    concentrated.holdoutQuality.leaveOneSourceRevisionOut.find(
      ({ sourceRevision }) => sourceRevision === sharedRevision,
    ).delta,
    0,
  );
  assert.equal(
    concentrated.gate,
    "holdout-not-qualified",
    "gains vanish after removing one source revision",
  );
}

const missingProvenance = asReport({
  spec: {
    ...api,
    tasks: api.tasks.map(({ sourceRevisions, ...task }) => task),
  },
  attempt: (row) => row,
});
assert.equal(missingProvenance.holdoutQuality.leaveOneSourceRevisionOut, null);
assert.equal(missingProvenance.gate, "holdout-not-qualified");

const unpriced = asReport({
  spec: api,
  attempt: (row) => ({
    ...row,
    estimatedCost: null,
  }),
});
assert.equal(unpriced.gate, "holdout-not-qualified");
const legacyPrefixCounter = asReport({
  spec: api,
  attempt: (row) => ({ ...row, efficiencyEvents: { prefixPreservations: 1 } }),
});
assert.equal(legacyPrefixCounter.attemptsWithConfirmedPrefixReuse, 0);
assert.equal(legacyPrefixCounter.gate, "holdout-not-qualified");
console.log(
  "24 historical scenarios and API/native qualification gates passed offline.",
);
