import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { report } from "./efficiency-report.mjs";
const spec = JSON.parse(
  await readFile("docs/performance/efficiency-pilot.json", "utf8"),
);
assert.equal(spec.tasks.length, 40);
assert.equal(spec.trials, 3);
const categories = new Map();
const root = await mkdtemp(join(tmpdir(), "gyro-pilot-fixtures-"));
try {
  for (const task of spec.tasks) {
    categories.set(task.category, (categories.get(task.category) ?? 0) + 1);
    const canonical = Object.fromEntries(
      Object.entries(task.files).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
    assert.equal(
      task.repositorySnapshot,
      "sha256:" +
        createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    );
    const workspace = join(root, task.id);
    await mkdir(workspace, { recursive: true });
    for (const [path, text] of Object.entries(task.files)) {
      const target = join(workspace, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, text);
    }
    const verifier = join(root, task.id + ".mjs");
    await writeFile(verifier, task.verifier);
    const verify = () =>
      spawnSync(process.execPath, ["--test", verifier], {
        env: { ...process.env, GYRO_VERIFY_WORKSPACE: workspace },
        timeout: 10000,
        encoding: "utf8",
      });
    assert.notEqual(
      verify().status,
      0,
      `${task.id} baseline must fail independent verification`,
    );
    for (const [path, text] of Object.entries(task.referenceSolution))
      await writeFile(join(workspace, path), text);
    const solved = verify();
    assert.equal(
      solved.status,
      0,
      `${task.id} reference must pass: ${solved.stdout} ${solved.stderr}`,
    );
  }
  assert.equal(categories.size, 5);
  for (const n of categories.values()) assert.equal(n, 8);
  const cost = (micros, snapshotId = "price-1") => ({
    currency: "USD",
    micros,
    snapshotId,
    estimated: true,
  });
  const base = {
    task: "a",
    repositorySnapshot: "sha256:" + "a".repeat(64),
    provider: "api",
    model: "m",
    effort: "medium",
    trial: 1,
    sessionCondition: "fresh-session",
    comparison: "gyro",
    cacheCondition: "unverified",
    outcome: "done",
    verified: true,
    retries: 0,
    generationRequests: 1,
    requestedReasoningEffort: "medium",
    requestedEffortCoverage: "observed",
    elapsedMs: 100,
    tokens: {
      measured: true,
      totalTokens: 100,
      accounting: {
        source: "provider",
        scope: "turn",
        coverage: "complete",
        known: { input: true, output: true },
      },
    },
    estimatedCost: cost(100),
  };
  const cohort = {
    schema: "gyro.efficiency-benchmark.v2",
    providers: [{ id: "api", model: "m", effort: "medium" }],
    tasks: [{ id: "a", repositorySnapshot: base.repositorySnapshot }],
    cacheConditions: ["fresh-session"],
    variants: ["baseline", "combined"],
    trials: 1,
  };
  let r = report(
    [
      { ...base, variant: "baseline" },
      {
        ...base,
        variant: "combined",
        estimatedCost: cost(70),
      },
    ],
    cohort,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "pilot-qualified",
  );
  r = report(
    [
      { ...base, variant: "baseline" },
      { ...base, variant: "combined", verified: false },
    ],
    cohort,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "correctness-regression",
  );
  r = report(
    [
      { ...base, variant: "baseline" },
      { ...base, variant: "combined", outcome: "budget-stop", verified: false },
    ],
    cohort,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "incomplete",
  );
  r = report(
    [
      { ...base, variant: "baseline" },
      { ...base, variant: "combined", estimatedCost: null },
    ],
    cohort,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "unknown-cost",
  );
  r = report(
    [
      { ...base, variant: "baseline" },
      { ...base, variant: "baseline" },
      {
        ...base,
        variant: "combined",
        estimatedCost: cost(70),
      },
    ],
    cohort,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "incomplete",
  );
  const candidate = { ...base, variant: "combined", estimatedCost: cost(70) };
  const gate = (rows) =>
    report(rows, cohort).groups.find((g) => g.variant === "combined").gate;
  const baseline = { ...base, variant: "baseline" };
  assert.equal(
    gate([
      baseline,
      { ...candidate, repositorySnapshot: "sha256:" + "b".repeat(64) },
    ]),
    "incomplete",
    "different source snapshots cannot pair",
  );
  assert.equal(
    gate([baseline, { ...baseline, task: "other" }, candidate]),
    "incomplete",
    "extra baseline rows cannot hide an incomplete cohort",
  );
  assert.equal(
    gate([
      { ...baseline, task: "other" },
      { ...candidate, task: "other" },
    ]),
    "incomplete",
    "a different complete-looking cohort must not replace requested tasks",
  );
  assert.equal(
    report([baseline, candidate], null).groups.find(
      (g) => g.variant === "combined",
    ).gate,
    "incomplete",
    "results without their requested spec cannot qualify",
  );
  assert.equal(
    gate([baseline, { ...candidate, verified: undefined }]),
    "incomplete",
    "missing verifier outcome is not a passing comparison",
  );
  assert.equal(
    gate([baseline, { ...candidate, elapsedMs: null }]),
    "incomplete",
    "missing timing cannot qualify the p95 gate",
  );
  assert.equal(
    gate([baseline, { ...candidate, retries: null }]),
    "incomplete",
    "unknown retry accounting cannot qualify",
  );
  assert.equal(
    gate([baseline, { ...candidate, generationRequests: null }]),
    "incomplete",
    "unknown request count cannot qualify",
  );
  assert.equal(
    gate([baseline, { ...candidate, requestedEffortCoverage: "unavailable" }]),
    "effort-not-comparable",
    "missing applied-request effort cannot qualify",
  );
  assert.equal(
    gate([baseline, { ...candidate, requestedReasoningEffort: "low" }]),
    "effort-not-comparable",
    "a non-profile variant cannot silently change effort",
  );
  assert.equal(
    gate([baseline, { ...candidate, estimatedCost: cost(80), elapsedMs: 110 }]),
    "pilot-qualified",
    "exactly 20% saving and 10% p95 slowdown meet inclusive gates",
  );
  assert.equal(
    gate([baseline, { ...candidate, estimatedCost: cost(81) }]),
    "target-not-met",
    "less than 20% saving does not pass",
  );
  assert.equal(
    gate([baseline, { ...candidate, elapsedMs: 111 }]),
    "latency-regression",
    "more than 10% p95 slowdown does not pass",
  );
  assert.equal(
    gate([
      baseline,
      {
        ...candidate,
        tokens: {
          ...base.tokens,
          accounting: { ...base.tokens.accounting, coverage: "partial" },
        },
      },
    ]),
    "unknown-cost",
    "partial provider usage cannot qualify",
  );
  assert.equal(
    gate([
      baseline,
      { ...candidate, tokens: { ...base.tokens, accounting: undefined } },
    ]),
    "unknown-cost",
    "legacy measured flags are not complete coverage",
  );
  assert.equal(
    gate([
      baseline,
      { ...candidate, estimatedCost: cost(70, "changed-price") },
    ]),
    "unknown-cost",
    "changing price snapshots cannot create savings",
  );
  assert.equal(
    gate([
      baseline,
      { ...candidate, estimatedCost: { ...cost(70), micros: -1 } },
    ]),
    "unknown-cost",
    "invalid prices cannot qualify",
  );
  const mixed = report(
    [
      baseline,
      candidate,
      { ...baseline, effort: "high" },
      { ...candidate, effort: "high" },
    ],
    cohort,
  ).groups.filter((g) => g.variant === "combined");
  assert.deepEqual(mixed.map((g) => g.effort).sort(), ["high", "medium"]);
  assert.equal(
    mixed.find((g) => g.effort === "medium").gate,
    "pilot-qualified",
  );
  assert.equal(
    mixed.find((g) => g.effort === "high").gate,
    "incomplete",
    "unrequested effort cannot qualify",
  );
  const routineCohort = {
    ...cohort,
    providers: [{ id: "api", model: "m", effort: "" }],
    variants: ["baseline", "routine-profile"],
  };
  const defaultEffort = {
    ...baseline,
    effort: "",
    requestedReasoningEffort: null,
  };
  const routine = {
    ...candidate,
    effort: "",
    variant: "routine-profile",
    requestedReasoningEffort: "low",
  };
  const routineGroup = (rows, pilot = routineCohort) =>
    report(rows, pilot).groups.find((g) => g.variant === "routine-profile");
  assert.equal(routineGroup([defaultEffort, routine]).gate, "pilot-qualified");
  assert.match(
    routineGroup([defaultEffort, routine]).effortComparison,
    /provider default/,
  );
  assert.equal(
    routineGroup([
      defaultEffort,
      { ...routine, requestedReasoningEffort: null },
    ]).gate,
    "effort-not-comparable",
    "unsupported Routine is not an effort comparison",
  );
  assert.equal(
    routineGroup([baseline, { ...routine, effort: "medium" }], {
      ...cohort,
      variants: ["baseline", "routine-profile"],
    }).gate,
    "incomplete",
    "Routine may not override explicit effort",
  );
  const native = report(
    [baseline, { ...candidate, variant: "native", comparison: "native" }],
    cohort,
  ).groups.find((g) => g.variant === "native");
  assert.equal(
    native.gate,
    "native-comparison",
    "native comparisons cannot auto-qualify API variants",
  );
  const recorded = report(
    [baseline, { ...candidate, cacheCondition: "observed-cache-read" }],
    cohort,
  ).groups.find((g) => g.variant === "combined");
  assert.equal(recorded.sessionConditions["fresh-session"], 1);
  assert.equal(
    recorded.cacheObservations["observed-cache-read"],
    1,
    "fresh session is not a cold cache claim",
  );
  const two = [
    baseline,
    {
      ...baseline,
      task: "b",
      outcome: "failed",
      verified: false,
      estimatedCost: cost(100),
    },
    { ...candidate, estimatedCost: cost(50) },
    {
      ...candidate,
      task: "b",
      outcome: "failed",
      verified: false,
      estimatedCost: cost(50),
      retries: 2,
      generationRequests: 3,
    },
  ];
  const failed = report(two, {
    ...cohort,
    tasks: [
      ...cohort.tasks,
      { id: "b", repositorySnapshot: base.repositorySnapshot },
    ],
  }).groups.find((g) => g.variant === "combined");
  assert.equal(
    failed.costPerVerifiedTaskMicros,
    100,
    "failed work is included in cost per successful task",
  );
  assert.equal(failed.retries, 2);
  assert.equal(failed.generationRequests, 4);
  console.log(
    "40 independent pilot verifiers and report gates passed; no provider calls",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
