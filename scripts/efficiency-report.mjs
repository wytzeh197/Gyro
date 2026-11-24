import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "./efficiency-run-manifest.mjs";
import {
  pairedQuality,
  tokenBreakdown,
  failureBreakdown,
} from "./efficiency-diagnostics.mjs";
const p95 = (values) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
    : null;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : sorted.length
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : null;
};
const key = (r) =>
  JSON.stringify([
    r.task,
    r.repositorySnapshot,
    r.verificationContract ?? null,
    r.provider,
    r.model,
    r.effort,
    r.trial,
    r.sessionCondition,
  ]);
function verificationContract(required) {
  if (required === undefined || (Array.isArray(required) && required.length === 0))
    return null;
  if (!Array.isArray(required) || !required.every((command) =>
    typeof command?.program === "string" && Array.isArray(command.args) &&
    command.args.every((arg) => typeof arg === "string") &&
    (command.cwd == null || typeof command.cwd === "string")))
    return undefined;
  return "sha256:" + sha256(JSON.stringify([
    "foreground-test/final-fixture-v1",
    required.map(({ program, args, cwd }) => [program, args, cwd ?? "."]),
  ]));
}
const completeUsage = (tokens) =>
  tokens?.measured === true &&
  tokens.accounting?.source === "provider" &&
  tokens.accounting?.coverage === "complete" &&
  ["turn", "task"].includes(tokens.accounting?.scope) &&
  tokens.accounting?.known?.input === true &&
  tokens.accounting?.known?.output === true &&
  Number.isSafeInteger(tokens.totalTokens) &&
  tokens.totalTokens >= 0;
const validCost = (cost) =>
  typeof cost?.currency === "string" &&
  /^[A-Z]{3}$/.test(cost.currency) &&
  typeof cost.snapshotId === "string" &&
  cost.snapshotId.trim().length > 0 &&
  cost.estimated === true &&
  Number.isSafeInteger(cost.micros) &&
  cost.micros >= 0;
const verified = (row) =>
  row.outcome === "done" && row.verified === true &&
  (row.verificationContract == null ||
    (row.independentVerifierPassed === true && row.requiredVerification?.verified === true));
const nonnegativeCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validIdentity = (row, nativeVersion) =>
  [row.task, row.provider, row.model].every(
    (value) => typeof value === "string" && value.trim().length > 0,
  ) &&
  typeof row.effort === "string" &&
  typeof row.repositorySnapshot === "string" &&
  /^sha256:[0-9a-f]{64}$/.test(row.repositorySnapshot) &&
  (row.verificationContract == null ||
    (typeof row.verificationContract === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(row.verificationContract) &&
      (row.verified !== true ||
        (row.independentVerifierPassed === true && row.requiredVerification?.verified === true)))) &&
  Number.isSafeInteger(row.trial) &&
  row.trial > 0 &&
  (nativeVersion
    ? row.nativeCliVersion === nativeVersion &&
      nonnegativeCount(row.gyroToolRequests)
    : nonnegativeCount(row.retries) &&
      nonnegativeCount(row.generationRequests)) &&
  typeof row.verified === "boolean" &&
  ["fresh-session", "resumed-session"].includes(row.sessionCondition) &&
  row.comparison === "gyro";
function expectedCohort(spec, provider, model, effort) {
  if (
    !spec ||
    spec.schema !== "gyro.efficiency-benchmark.v2" ||
    !Array.isArray(spec.providers) ||
    !Array.isArray(spec.tasks) ||
    !Array.isArray(spec.cacheConditions) ||
    !Number.isSafeInteger(spec.trials) ||
    spec.trials < 1 ||
    spec.tasks.length === 0 ||
    spec.cacheConditions.length === 0 ||
    (Array.isArray(spec.variants) &&
      spec.variants.includes("routine-profile") &&
      (typeof effort !== "string" || effort.trim() !== "")) ||
    new Set(spec.providers.map((p) => p.id)).size !== spec.providers.length ||
    spec.providers.filter(
      (p) => p.id === provider && p.model === model && p.effort === effort,
    ).length !== 1 ||
    new Set(spec.cacheConditions).size !== spec.cacheConditions.length ||
    !spec.cacheConditions.every((c) =>
      ["fresh-session", "resumed-session"].includes(c),
    )
  )
    return null;
  const keys = new Set();
  for (const task of spec.tasks) {
    const contract = verificationContract(task.requiredVerificationCommands);
    if (contract === undefined) return null;
    for (const sessionCondition of spec.cacheConditions) {
      for (let trial = 1; trial <= spec.trials; trial++) {
        const row = {
          task: task.id,
          repositorySnapshot: task.repositorySnapshot,
          verificationContract: contract,
          provider,
          model,
          effort,
          trial,
          sessionCondition,
          comparison: "gyro",
          verified: false,
          retries: 0,
          generationRequests: 0,
          nativeCliVersion: spec.nativeCliVersion,
          gyroToolRequests: 0,
        };
        if (!validIdentity(row, spec.nativeCliVersion)) return null;
        keys.add(key(row));
      }
    }
  }
  return keys.size ===
    spec.tasks.length * spec.cacheConditions.length * spec.trials
    ? keys
    : null;
}

const pairDelta = ([base, candidate]) =>
  Number(verified(candidate)) - Number(verified(base));
const meanPairDelta = (pairs) =>
  pairs.length
    ? pairs.reduce((sum, pair) => sum + pairDelta(pair), 0) / pairs.length
    : null;

function leaveOneSourceRevisionOut(pairs, tasks) {
  const revisionsByTask = new Map();
  for (const { id, sourceRevisions } of tasks) {
    if (
      !Array.isArray(sourceRevisions) ||
      !sourceRevisions.length ||
      !sourceRevisions.every(
        (revision) => typeof revision === "string" && /^[0-9a-f]{40}$/.test(revision),
      )
    ) {
      return null;
    }
    revisionsByTask.set(id, new Set(sourceRevisions));
  }
  const revisions = [
    ...new Set(tasks.flatMap(({ sourceRevisions }) => sourceRevisions)),
  ].sort();
  if (revisions.length < 2) return null;
  return revisions.map((sourceRevision) => {
    // Multi-file scenarios count against each revision they use.
    const remaining = pairs.filter(
      ([, candidate]) => !revisionsByTask.get(candidate.task).has(sourceRevision),
    );
    return { sourceRevision, pairs: remaining.length, delta: meanPairDelta(remaining) };
  });
}

// Resample task IDs together so fresh and resumed runs remain paired. Related
// tasks can still share source, so test that sensitivity separately.
function holdoutQuality(pairs, tasks, complete) {
  if (!complete || !pairs.length) return null;
  const scores = new Map(tasks.map(({ id }) => [id, []]));
  for (const pair of pairs) scores.get(pair[1].task).push(pairDelta(pair));
  const means = [...scores.values()].map(
    (items) => items.reduce((sum, value) => sum + value, 0) / items.length,
  );
  let seed = 0x4759524f;
  const samples = Array.from({ length: 4000 }, () => {
    let sum = 0;
    for (let draw = 0; draw < means.length; draw++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      sum += means[Math.floor((seed / 2 ** 32) * means.length)];
    }
    return sum / means.length;
  }).sort((a, b) => a - b);
  const conditions = Object.fromEntries(
    ["fresh-session", "resumed-session"].map((condition) => {
      const rows = pairs.filter(([, r]) => r.sessionCondition === condition);
      return [condition, meanPairDelta(rows)];
    }),
  );
  return {
    delta: meanPairDelta(pairs),
    conditions,
    pairedTaskBootstrap95: [samples[99], samples[3899]],
    leaveOneSourceRevisionOut: leaveOneSourceRevisionOut(pairs, tasks),
  };
}
export function report(records, spec = null) {
  const nativeVersion = spec?.nativeCliVersion;
  const heldOut = spec?.heldOut === true;
  const expectedPairs =
    spec &&
    Array.isArray(spec.tasks) &&
    Array.isArray(spec.cacheConditions) &&
    Number.isSafeInteger(spec.trials)
      ? spec.tasks.length * spec.trials * spec.cacheConditions.length
      : null;
  const variants = [...new Set(records.map((r) => r.variant))];
  const baseline = new Map(
    records.filter((r) => r.variant === "baseline").map((r) => [key(r), r]),
  );
  const groups = [];
  for (const provider of [...new Set(records.map((r) => r.provider))])
    for (const model of [
      ...new Set(
        records.filter((r) => r.provider === provider).map((r) => r.model),
      ),
    ])
      for (const effort of [
        ...new Set(
          records
            .filter((r) => r.provider === provider && r.model === model)
            .map((r) => r.effort),
        ),
      ])
        for (const variant of variants) {
          const selected = records.filter(
            (r) =>
              r.provider === provider &&
              r.model === model &&
              r.effort === effort &&
              r.variant === variant,
          );
          if (!selected.length) continue;
          const evaluated = selected.filter((r) =>
            ["done", "failed"].includes(r.outcome),
          );
          const successes = evaluated.filter(verified).length;
          const pairs = evaluated
            .map((r) => [baseline.get(key(r)), r])
            .filter(([a]) => a && ["done", "failed"].includes(a.outcome));
          const regressions = pairs
            .filter(([a, b]) => verified(a) && !verified(b))
            .map(([, b]) => ({
              task: b.task,
              trial: b.trial,
              sessionCondition: b.sessionCondition,
            }));
          const completePairs = pairs.filter(
            ([a, b]) =>
              completeUsage(a.tokens) &&
              completeUsage(b.tokens) &&
              validCost(a.estimatedCost) &&
              validCost(b.estimatedCost) &&
              a.estimatedCost.currency === b.estimatedCost.currency &&
              a.estimatedCost.snapshotId === b.estimatedCost.snapshotId,
          );
          const currencies = [
            ...new Set(completePairs.map(([, b]) => b.estimatedCost.currency)),
          ];
          const priceSnapshots = [
            ...new Set(
              completePairs.map(([, b]) => b.estimatedCost.snapshotId),
            ),
          ];
          const costSum = (xs, i) =>
            xs.reduce((n, p) => n + p[i].estimatedCost.micros, 0);
          const baselineSuccess = completePairs.filter(([a]) =>
            verified(a),
          ).length;
          const variantSuccess = completePairs.filter(([, b]) =>
            verified(b),
          ).length;
          const baselineCost = costSum(completePairs, 0);
          const variantCost = costSum(completePairs, 1);
          const validSums =
            Number.isSafeInteger(baselineCost) &&
            Number.isSafeInteger(variantCost);
          const basePerTask =
            baselineSuccess &&
            validSums &&
            currencies.length === 1 &&
            priceSnapshots.length === 1 &&
            completePairs.length === pairs.length
              ? baselineCost / baselineSuccess
              : null;
          const perTask =
            variantSuccess &&
            validSums &&
            currencies.length === 1 &&
            priceSnapshots.length === 1 &&
            completePairs.length === pairs.length
              ? variantCost / variantSuccess
              : null;
          const reduction =
            basePerTask > 0 && perTask !== null
              ? 1 - perTask / basePerTask
              : null;
          const timedPairs = pairs.filter(
            ([a, b]) =>
              Number.isSafeInteger(a.elapsedMs) &&
              a.elapsedMs >= 0 &&
              Number.isSafeInteger(b.elapsedMs) &&
              b.elapsedMs >= 0,
          );
          const baselineP95 = p95(timedPairs.map(([a]) => a.elapsedMs));
          const variantP95 = p95(timedPairs.map(([, b]) => b.elapsedMs));
          const slowdown =
            baselineP95 > 0 && variantP95 !== null
              ? variantP95 / baselineP95 - 1
              : null;
          const baselineRows = records.filter(
            (r) =>
              r.provider === provider &&
              r.model === model &&
              r.effort === effort &&
              r.variant === "baseline",
          );
          const expected = expectedCohort(spec, provider, model, effort);
          const complete =
            expected !== null &&
            expected.size === expectedPairs &&
            Array.isArray(spec.variants) &&
            spec.variants.includes("baseline") &&
            spec.variants.includes(variant) &&
            baselineRows.length === expectedPairs &&
            selected.length === expectedPairs &&
            pairs.length === expectedPairs &&
            new Set(pairs.map(([, b]) => key(b))).size === pairs.length &&
            selected.length === evaluated.length &&
            baselineRows.every(
              (r) =>
                ["done", "failed"].includes(r.outcome) &&
                validIdentity(r, nativeVersion),
            ) &&
            selected.every((row) => validIdentity(row, nativeVersion)) &&
            baselineRows.every((row) => expected.has(key(row))) &&
            selected.every((row) => expected.has(key(row))) &&
            new Set(baselineRows.map(key)).size === baselineRows.length &&
            timedPairs.length === pairs.length;
          const tokenPairs = pairs.filter(
            ([a, b]) =>
              completeUsage(a.tokens) &&
              completeUsage(b.tokens) &&
              Number.isFinite(a.tokens.totalTokens) &&
              Number.isFinite(b.tokens.totalTokens),
          );
          const baseSuccess = tokenPairs.filter(([a]) => verified(a)).length;
          const optimizedSuccess = tokenPairs.filter(([, b]) =>
            verified(b),
          ).length;
          const baseTokens = baseSuccess
            ? tokenPairs.reduce((n, [a]) => n + a.tokens.totalTokens, 0) /
              baseSuccess
            : null;
          const tokensPerTask = optimizedSuccess
            ? tokenPairs.reduce((n, [, b]) => n + b.tokens.totalTokens, 0) /
              optimizedSuccess
            : null;
          const tokenReduction =
            tokenPairs.length === pairs.length &&
            baseTokens > 0 &&
            tokensPerTask !== null
              ? 1 - tokensPerTask / baseTokens
              : null;
          // Use exact integer cross-products at the acceptance boundaries:
          // floating point makes 80/100 appear just below a 20% reduction.
          const costGate =
            reduction !== null &&
            baselineCost > 0 &&
            BigInt(variantCost) * BigInt(baselineSuccess) * 5n <=
              BigInt(baselineCost) * BigInt(variantSuccess) * 4n;
          const latencyGate =
            baselineP95 > 0 &&
            variantP95 !== null &&
            BigInt(variantP95) * 10n <= BigInt(baselineP95) * 11n;
          const effortGate = pairs.every(([a, b]) => {
            const recorded = (row) =>
              row.requestedEffortCoverage === "observed" ||
              (nativeVersion &&
                row.requestedEffortCoverage === "native-launch-configured");
            if (!recorded(a) || !recorded(b)) return false;
            const baselineEffort = effort.trim() || null;
            return (
              a.requestedReasoningEffort === baselineEffort &&
              b.requestedReasoningEffort ===
                (variant === "routine-profile" ? "low" : baselineEffort)
            );
          });
          const attemptsWithConfirmedPrefixReuse = selected.filter((row) => {
            const count = row.efficiencyEvents?.confirmedPrefixReuses;
            return nonnegativeCount(count) && count > 0;
          }).length;
          const prefixRequired =
            variant === "stable-api-prefix" ||
            (variant === "harness-candidate" && spec?.candidatePolicies?.stableApiPrefix);
          const prefixObserved = attemptsWithConfirmedPrefixReuse > 0;
          const prefixExercised = !prefixRequired || prefixObserved;
          const qualifies =
            complete &&
            regressions.length === 0 &&
            effortGate &&
            latencyGate &&
            costGate &&
            prefixExercised &&
            completePairs.length === pairs.length;
          const holdout =
            heldOut && variant === "harness-candidate"
              ? holdoutQuality(pairs, spec.tasks, complete)
              : null;
          const criticalTasks = new Set(
            spec?.tasks?.filter((task) => task.critical).map((task) => task.id),
          );
          const safetyGate =
            selected.every((row) => row.scopeVerified === true) &&
            !regressions.some((row) => criticalTasks.has(row.task));
          const nativeQualityGate =
            complete &&
            effortGate &&
            latencyGate &&
            safetyGate &&
            regressions.length === 0;
          const checkpointObserved = selected.some(
            (row) => row.checkpointRecoveries > 0,
          );
          const exercised =
            (!spec?.candidatePolicies?.checkpointRecovery ||
              checkpointObserved) &&
            prefixExercised;
          const holdoutQualifies =
            holdout !== null &&
            pairs.length === 48 &&
            criticalTasks.size > 0 &&
            holdout.delta >= 0.05 &&
            Object.values(holdout.conditions).every((delta) => delta > 0) &&
            holdout.pairedTaskBootstrap95[0] > 0 &&
            holdout.leaveOneSourceRevisionOut?.every(({ delta }) => delta > 0) &&
            safetyGate &&
            effortGate &&
            latencyGate &&
            exercised &&
            (nativeVersion ||
              (costGate && completePairs.length === pairs.length));
          groups.push({
            provider,
            model,
            effort,
            variant,
            effortComparison:
              variant === "routine-profile"
                ? "Gyro-requested low vs provider default; provider compliance unverified"
                : "matched Gyro-requested effort",
            attempts: selected.length,
            attemptsWithConfirmedPrefixReuse,
            evaluated: evaluated.length,
            successes,
            budgetStops: selected.filter((r) =>
              r.outcome?.includes("budget-stop"),
            ).length,
            unavailable: selected.filter(
              (r) =>
                !evaluated.includes(r) && !r.outcome?.includes("budget-stop"),
            ).length,
            failedAttempts: evaluated.length - successes,
            pairedQuality: pairedQuality(pairs, complete),
            holdoutQuality: holdout,
            exercised: { checkpointObserved, prefixObserved },
            nativeCliVersion: nativeVersion ?? null,
            scopeVerified: safetyGate,
            gyroToolRequests: selected.every((r) =>
              nonnegativeCount(r.gyroToolRequests),
            )
              ? selected.reduce((n, r) => n + r.gyroToolRequests, 0)
              : null,
            schemaValidToolRequests: selected.every((r) =>
              nonnegativeCount(r.schemaValidToolRequests),
            )
              ? selected.reduce((n, r) => n + r.schemaValidToolRequests, 0)
              : null,
            checkpointRecoveries: selected.every((r) =>
              nonnegativeCount(r.checkpointRecoveries),
            )
              ? selected.reduce((n, r) => n + r.checkpointRecoveries, 0)
              : null,
            tokenBreakdown: tokenBreakdown(selected),
            failureBreakdown: failureBreakdown(selected),
            retries: selected.every(
              (r) => Number.isSafeInteger(r.retries) && r.retries >= 0,
            )
              ? selected.reduce((n, r) => n + r.retries, 0)
              : null,
            generationRequests: selected.every(
              (r) =>
                Number.isSafeInteger(r.generationRequests) &&
                r.generationRequests >= 0,
            )
              ? selected.reduce((n, r) => n + r.generationRequests, 0)
              : null,
            sessionConditions: Object.fromEntries(
              ["fresh-session", "resumed-session"].map((name) => [
                name,
                selected.filter((r) => r.sessionCondition === name).length,
              ]),
            ),
            cacheObservations: Object.fromEntries(
              [
                "observed-cache-read",
                "observed-zero-cache-read",
                "unverified",
              ].map((name) => [
                name,
                selected.filter(
                  (r) =>
                    ([
                      "observed-cache-read",
                      "observed-zero-cache-read",
                    ].includes(r.cacheCondition)
                      ? r.cacheCondition
                      : "unverified") === name,
                ).length,
              ]),
            ),
            pairs: pairs.length,
            pricedPairs: completePairs.length,
            currency: currencies.length === 1 ? currencies[0] : null,
            priceSnapshot:
              priceSnapshots.length === 1 ? priceSnapshots[0] : null,
            tokensPerVerifiedTask: tokensPerTask,
            tokenReduction,
            costPerVerifiedTaskMicros: perTask,
            costReduction: reduction,
            p95Ms: variantP95,
            medianMs: median(timedPairs.map(([, b]) => b.elapsedMs)),
            baselineMedianMs: median(timedPairs.map(([a]) => a.elapsedMs)),
            p95Slowdown: slowdown,
            regressions,
            gate:
              variant === "native"
                ? "native-comparison"
                : variant === "baseline"
                  ? "baseline"
                  : heldOut
                    ? holdoutQualifies
                      ? "holdout-qualified"
                      : "holdout-not-qualified"
                    : nativeVersion
                      ? nativeQualityGate
                        ? "native-pilot-qualified"
                        : "native-pilot-not-qualified"
                      : qualifies
                        ? "pilot-qualified"
                        : !complete
                          ? "incomplete"
                          : regressions.length
                            ? "correctness-regression"
                            : !effortGate
                              ? "effort-not-comparable"
                              : slowdown !== null && !latencyGate
                                ? "latency-regression"
                                : !prefixExercised
                                  ? "policy-not-exercised"
                                  : reduction === null
                                    ? "unknown-cost"
                                    : "target-not-met",
          });
        }
  return {
    schema: "gyro.efficiency-report.v2",
    expectedPairs,
    holdoutFingerprint: heldOut ? sha256(JSON.stringify(spec.tasks)) : null,
    groups,
    limitations: [
      "Pilot evidence does not prove production-wide quality equivalence.",
      "All failed attempts and budget stops remain represented.",
      "Unpriced or incomplete usage cannot qualify a monetary savings claim.",
      "Native comparisons and subscription observations are reported separately.",
      "Fresh and resumed sessions do not establish cold or warm provider caches; observed cache-read counts are listed independently.",
      "Requested model IDs may be aliases; provider model revisions and equal cache conditions are not proven by the cohort identity.",
      "Routine-profile compares Gyro-requested low effort with an unspecified provider default; it does not prove what effort the provider used.",
      "Paired quality changes describe this cohort, not statistical significance or production-wide improvement. Incomplete cohorts have no success-rate delta.",
      "Input includes cache reads and writes; output includes reasoning. Unknown token breakdowns stay unknown, and observed subtotals are available in JSON.",
      "Owned adapters count schema-valid model tool requests before broker checks. Broker request events are recorded after preflight and before approvals. Neither count measures completed actions.",
    ],
  };
}
export function markdown(result) {
  const shownEffort = (value) => value?.trim() || "provider default";
  const number = (value) =>
    value === null || value === undefined ? "unknown" : value;
  return (
    "# Gyro efficiency pilot\n\n| Provider / model / effort | Variant | Verified / attempts | Paired / priced | Cost reduction | p95 change | Gate |\n|---|---|---:|---:|---:|---:|---|\n" +
    result.groups
      .map(
        (g) =>
          `| ${g.provider} / ${g.model} / ${shownEffort(g.effort)} | ${g.variant} | ${g.successes}/${g.attempts} | ${g.pairs}/${g.pricedPairs} | ${g.costReduction === null ? "unknown" : (g.costReduction * 100).toFixed(1) + "%"} | ${g.p95Slowdown === null ? "unknown" : (g.p95Slowdown * 100).toFixed(1) + "%"} | ${g.gate} |`,
      )
      .join("\n") +
    "\n\nPaired correctness (candidate versus baseline):\n\n| Provider / model / effort | Variant | Both verified | Improved / regressed | Neither verified | Unknown | Success-rate change | Coverage |\n|---|---|---:|---:|---:|---:|---:|---|\n" +
    result.groups
      .map((g) => {
        const q = g.pairedQuality;
        return `| ${g.provider} / ${g.model} / ${shownEffort(g.effort)} | ${g.variant} | ${q.bothVerified} | ${q.improved} / ${q.regressed} | ${q.neitherVerified} | ${q.unknown} | ${q.successRateChange === null ? "unknown" : (q.successRateChange * 100).toFixed(1) + " pp"} | ${q.coverage} |`;
      })
      .join("\n") +
    "\n\nProvider-reported token totals (all attempts, including failures):\n\n| Provider / model / effort | Variant | Input | Uncached input | Cache read | Cache write | Output | Reasoning subset |\n|---|---|---:|---:|---:|---:|---:|---:|\n" +
    result.groups
      .map((g) => {
        const t = g.tokenBreakdown;
        return `| ${g.provider} / ${g.model} / ${shownEffort(g.effort)} | ${g.variant} | ${["inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningOutputTokens"].map((key) => number(t[key].total)).join(" | ")} |`;
      })
      .join("\n") +
    "\n\nFailure breakdown:\n\n| Provider / model / effort | Variant | Execution | Verification | Unknown verification | Budget stop | Unavailable |\n|---|---|---:|---:|---:|---:|---:|\n" +
    result.groups
      .map((g) => {
        const f = g.failureBreakdown;
        return `| ${g.provider} / ${g.model} / ${shownEffort(g.effort)} | ${g.variant} | ${f.executionFailed} | ${f.verificationFailed} | ${f.verificationUnknown} | ${f.budgetStopped} | ${f.unavailable} |`;
      })
      .join("\n") +
    "\n\nTool requests (all attempts):\n\n| Provider / model / effort | Variant | Schema-valid model requests | Broker request events |\n|---|---|---:|---:|\n" +
    result.groups
      .map(
        (g) =>
          `| ${g.provider} / ${g.model} / ${shownEffort(g.effort)} | ${g.variant} | ${number(g.schemaValidToolRequests)} | ${number(g.gyroToolRequests)} |`,
      )
      .join("\n") +
    "\n\nSession conditions and provider-reported cache reads:\n\n| Provider / model / effort | Variant | Fresh / resumed | Cache read / reported zero / unknown |\n|---|---|---:|---:|\n" +
    result.groups
      .map(
        (g) =>
          `| ${g.provider} / ${g.model} / ${shownEffort(g.effort)} | ${g.variant} | ${g.sessionConditions["fresh-session"]} / ${g.sessionConditions["resumed-session"]} | ${g.cacheObservations["observed-cache-read"]} / ${g.cacheObservations["observed-zero-cache-read"]} / ${g.cacheObservations.unverified} |`,
      )
      .join("\n") +
    "\n\n" +
    result.limitations.map((l) => `- ${l}`).join("\n") +
    "\n\nTask regressions:\n\n" +
    result.groups
      .flatMap((g) =>
        g.regressions.map(
          (r) =>
            `- ${g.provider} / ${g.variant}: ${r.task}, repetition ${r.trial}, ${r.sessionCondition}`,
        ),
      )
      .join("\n") +
    "\n"
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw Error(
      "Usage: node scripts/efficiency-report.mjs RESULTS_JSON OUTPUT_DIRECTORY",
    );
  const source = JSON.parse(await readFile(input, "utf8"));
  const spec = await readFile(join(resolve(input, ".."), "spec.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const result = report(source.records, spec);
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "efficiency-report.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  await writeFile(join(output, "efficiency-report.md"), markdown(result));
}
