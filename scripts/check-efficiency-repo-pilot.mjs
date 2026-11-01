import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  spec,
  controls,
  baselineFailures,
  provenance,
  manifestPath,
  serializedSpec,
  snapshot,
  sha256,
} from "./efficiency-repo-pilot.mjs";

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--write"),
  "Usage: node scripts/check-efficiency-repo-pilot.mjs [--write]",
);
assert.ok(
  Number(process.versions.node.split(".")[0]) >= 24,
  "Node 24+ is required to execute the frozen TypeScript modules",
);
if (!args.includes("--write"))
  assert.equal(
    readFileSync(manifestPath, "utf8"),
    serializedSpec,
    "Manifest drift: inspect the change, then regenerate with --write",
  );
assert.equal(
  spec.providers.length,
  0,
  "The checked-in template must not invoke a provider",
);
assert.equal(spec.executionBudget.maxCalls, 0);
assert.equal(spec.executionBudget.maxObservedTokens, 0);
assert.equal(spec.prices.length, 0);
assert.equal(spec.tasks.length, 3);
assert.equal(new Set(spec.tasks.map((task) => task.id)).size, 3);

const root = mkdtempSync(join(tmpdir(), "gyro-efficiency-repo-"));
let runCount = 0;
function write(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}
function execute(task, patch, smoke = false) {
  const directory = join(root, String(++runCount));
  const workspace = join(directory, "workspace");
  for (const [path, source] of Object.entries({ ...task.files, ...patch }))
    write(join(workspace, path), source);
  const verifier = join(directory, "independent-verifier.mjs");
  write(verifier, task.verifier);
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      smoke ? join(workspace, "tests/smoke.mjs") : verifier,
    ],
    {
      cwd: workspace,
      env: { ...process.env, GYRO_VERIFY_WORKSPACE: workspace },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
    },
  );
  assert.equal(
    result.error,
    undefined,
    `${task.id}: verifier process error: ${result.error}`,
  );
  assert.equal(result.signal, null, `${task.id}: verifier was interrupted`);
  const output = result.stdout + result.stderr;
  const tests = Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]);
  const passed = Number(result.stdout.match(/^# pass (\d+)$/m)?.[1]);
  const failed = Number(result.stdout.match(/^# fail (\d+)$/m)?.[1]);
  assert.ok(
    Number.isSafeInteger(tests) && tests > 0,
    `${task.id}: missing test results\n${output}`,
  );
  return { status: result.status, output, tests, passed, failed };
}
function rejectBehavior(result, expected, label) {
  assert.notEqual(result.status, 0, `${label}: faulty implementation passed`);
  assert.ok(
    result.output
      .split("\n")
      .some((line) => /^not ok \d+ - /.test(line) && line.endsWith(expected)),
    `${label}: did not fail the intended behavioral assertion\n${result.output}`,
  );
  assert.ok(
    !/ERR_MODULE_NOT_FOUND|SyntaxError:|ERR_UNKNOWN_FILE_EXTENSION/.test(
      result.output,
    ),
    `${label}: failed to load instead of failing behavior\n${result.output}`,
  );
}
const results = [];
try {
  for (const [index, task] of spec.tasks.entries()) {
    assert.equal(task.repositorySnapshot, snapshot(task.files));
    assert.ok(task.turns.length >= 1 && task.turns.length <= 8);
    assert.ok(Object.keys(task.files).length <= 100);
    assert.ok(task.allowedChanges.length > 0);
    for (const path of [...Object.keys(task.files), ...task.allowedChanges])
      assert.ok(
        !path.startsWith("/") && !path.split("/").includes(".."),
        `Unsafe fixture path: ${path}`,
      );
    for (const path of Object.keys(task.referenceSolution))
      assert.ok(task.allowedChanges.includes(path));
    const smoke = execute(task, {}, true);
    assert.equal(
      smoke.status,
      0,
      `${task.id}: public smoke test must load the baseline\n${smoke.output}`,
    );
    const baseline = execute(task, {});
    rejectBehavior(baseline, baselineFailures[index], task.id);
    const reference = execute(task, task.referenceSolution);
    assert.equal(
      reference.status,
      0,
      `${task.id}: reference failed\n${reference.output}`,
    );
    assert.equal(reference.failed, 0);
    const rejected = [];
    for (const control of controls[index]) {
      for (const path of Object.keys(control.patch))
        assert.ok(task.allowedChanges.includes(path));
      const result = execute(task, {
        ...task.referenceSolution,
        ...control.patch,
      });
      rejectBehavior(result, control.failure, `${task.id}/${control.name}`);
      rejected.push({
        name: control.name,
        expectedFailure: control.failure,
        rejected: true,
      });
    }
    results.push({
      taskId: task.id,
      repositorySnapshot: task.repositorySnapshot,
      turns: task.turns.length,
      publicSmokePassed: true,
      baseline: {
        tests: baseline.tests,
        passed: baseline.passed,
        failed: baseline.failed,
      },
      reference: {
        tests: reference.tests,
        passed: reference.passed,
        failed: reference.failed,
      },
      controls: rejected,
    });
    console.log(
      `${task.id}: baseline rejected, ${reference.passed} reference checks passed, ${rejected.length} faulty repairs rejected`,
    );
  }
  const report = {
    schema: "gyro.efficiency-repo-validation.v1",
    evidence: "offline-reference-and-mutation-checks",
    nodeVersion: process.versions.node,
    manifestSha256: sha256(serializedSpec),
    sourceHead: provenance.repositoryHead,
    frozenSourceCount: provenance.files.length,
    providerCalls: 0,
    measuredSavings: null,
    observedCompaction: null,
    observedSpillRecovery: null,
    tasks: results,
  };
  if (args.includes("--write")) {
    writeFileSync(manifestPath, serializedSpec);
    writeFileSync(
      fileURLToPath(
        new URL(
          "../docs/performance/efficiency-repo-validation.json",
          import.meta.url,
        ),
      ),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  console.log(
    `Validated ${results.length} frozen tasks, ${results.reduce((sum, value) => sum + value.reference.passed, 0)} reference checks and ${results.reduce((sum, value) => sum + value.controls.length, 0)} faulty-repair controls. No provider calls.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
