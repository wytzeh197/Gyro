import assert from "node:assert/strict";
import {
  gitSetupMessage, hasOnlyGitWarnings, preparationStatusLabel, reconcileGitPreparation, retainGitSnapshot,
} from "../packages/ui/src/workspace-preparation.ts";

const base = {
  runId: "current", workspacePath: "/project", phase: "tests", status: "degraded",
  completedSteps: 5, totalSteps: 5, message: "Workspace ready with warnings",
  gitState: "timed-out",
  errors: [
    { phase: "git", gitCheck: "status", message: "status timeout" },
    { phase: "git", gitCheck: "branches", message: "branch timeout" },
  ],
};
const request = { workspacePath: "/project/", runId: "current", check: "status" };
const ready = { available: true, readState: "ready" };
assert.equal(preparationStatusLabel(base), "Git warning");
let progress = reconcileGitPreparation(base, request, ready);
assert.deepEqual(progress.errors, [base.errors[1]]);
assert.equal(progress.status, "degraded");
progress = reconcileGitPreparation(progress, { ...request, check: "branches" }, ready);
assert.equal(progress.status, "ready");
assert.deepEqual(progress.errors, []);
for (const readState of ["not-repository", "unavailable"]) {
  const optional = reconcileGitPreparation(
    { ...base, errors: [base.errors[0]] }, request, { available: false, readState },
  );
  assert.equal(optional.status, "ready");
  assert.ok(gitSetupMessage(optional.gitState));
}
for (const changed of [
  { ...request, runId: "previous" }, { ...request, workspacePath: "/other" },
]) assert.equal(reconcileGitPreparation(base, changed, ready), base);
for (const status of ["preparing", "failed"]) {
  const active = { ...base, status };
  assert.equal(reconcileGitPreparation(active, request, ready), active);
}
const watcher = { phase: "watcher", message: "watcher failed" };
progress = reconcileGitPreparation({ ...base, errors: [watcher, base.errors[0]] }, request, ready);
assert.equal(progress.status, "degraded");
assert.deepEqual(progress.errors, [watcher]);
assert.equal(hasOnlyGitWarnings(progress), false);
assert.equal(preparationStatusLabel(progress), "Warnings");
progress = reconcileGitPreparation(base, request, { ...ready, stale: true, error: "last-known data" });
assert.equal(progress.status, "degraded");
assert.equal(progress.errors.filter((error) => error.gitCheck === "status").length, 1);
assert.equal(progress.errors.find((error) => error.gitCheck === "status").message, "last-known data");
assert.equal(reconcileGitPreparation(undefined, request, ready), undefined);
assert.equal(gitSetupMessage("ready"), undefined);
assert.equal(preparationStatusLabel({ ...base, gitRetrying: true }), "Checking Git");
const previous = { available: true, workspacePath: "/project", readState: "ready",
  files: [{ path: "pending.txt" }], lastCheckedAt: "old" };
const failed = { available: false, workspacePath: "/project/", readState: "failed", files: [], error: "transport" };
const retained = retainGitSnapshot(previous, failed);
assert.equal(retained.stale, true);
assert.deepEqual(retained.files, previous.files);
assert.equal(retained.lastCheckedAt, "old");
const differentRoot = { ...failed, workspacePath: "/other" };
assert.equal(retainGitSnapshot(previous, differentRoot), differentRoot);
for (const readState of ["not-repository", "unavailable"]) {
  const optional = { ...failed, readState, error: undefined };
  assert.equal(retainGitSnapshot(previous, optional), optional);
}
console.log("Git readiness: optional setup, independent recovery, stale data and run/workspace isolation passed.");
