import assert from "node:assert/strict";
import { createGithubRefreshController } from "../apps/desktop/src/github-refresh.ts";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

const settle = () => new Promise(setImmediate);
const availability = (repository) => ({
  schema: "gyro.github-availability.v1",
  available: true,
  cliInstalled: true,
  authenticated: true,
  repository,
});
const run = (id) => ({ id, title: `Run ${id}`, state: "success" });
const pullRequest = (number) => ({ number, title: `PR ${number}` });

function harness() {
  let state = createInitialWorkbenchState();
  const actions = [];
  const requests = [];
  const dispatch = (action) => {
    actions.push(action);
    state = workbenchReducer(state, action);
  };
  const controller = createGithubRefreshController({
    dispatch,
    invoke(command, args) {
      return new Promise((resolve, reject) => {
        const request = {
          command,
          root: args.request.workspacePath,
          settled: false,
          resolve(value) {
            request.settled = true;
            resolve(value);
          },
          reject(error) {
            request.settled = true;
            reject(error);
          },
        };
        requests.push(request);
      });
    },
  });
  function request(command, root) {
    const match = requests.find(
      (item) => item.command === command && item.root === root && !item.settled,
    );
    assert.ok(match, `Expected pending ${command} for ${root}`);
    return match;
  }
  function setWorkspace(root) {
    controller.setWorkspace(root);
    dispatch({ type: "github-reset" });
  }
  async function status(root, value = availability(root)) {
    request("github_status", root).resolve(value);
    await settle();
  }
  return {
    controller,
    actions,
    requests,
    dispatch,
    request,
    setWorkspace,
    status,
    get github() {
      return state.ide.github;
    },
  };
}

// Polling and manual refreshes join the same request; completion permits a new
// refresh instead of leaving the controller permanently attached to old data.
{
  const h = harness();
  h.setWorkspace("/a");
  const first = h.controller.refresh("/a");
  assert.equal(h.controller.refresh("/a"), first);
  assert.equal(h.requests.length, 1);
  assert.equal(h.github.loading, true);
  await h.status("/a");
  assert.equal(h.requests.length, 3);
  assert.equal(h.controller.refresh("/a"), first);
  h.request("github_workflow_runs", "/a").resolve([run(1)]);
  h.request("github_pull_requests", "/a").resolve([pullRequest(2)]);
  await first;
  assert.deepEqual(h.github.runs, [run(1)]);
  assert.deepEqual(h.github.pullRequests, [pullRequest(2)]);
  assert.equal(h.github.loading, false);
  const next = h.controller.refresh("/a");
  assert.notEqual(next, first);
  await h.status("/a", { ...availability("/a"), available: false });
  await next;
  assert.equal(h.requests.length, 4, "Unavailable repos do not request lists");
}

// Either endpoint can fail independently. Keep the failed endpoint's last
// successful data while updating its healthy sibling and retaining the error.
for (const failing of ["github_workflow_runs", "github_pull_requests"]) {
  const h = harness();
  h.setWorkspace("/a");
  h.dispatch({ type: "github-set-runs", runs: [run(1)] });
  h.dispatch({
    type: "github-set-pull-requests",
    pullRequests: [pullRequest(1)],
  });
  const refresh = h.controller.refresh("/a");
  await h.status("/a");
  h.request(failing, "/a").reject(new Error("Permission denied"));
  const healthy =
    failing === "github_workflow_runs"
      ? "github_pull_requests"
      : "github_workflow_runs";
  h.request(healthy, "/a").resolve(
    healthy === "github_workflow_runs" ? [run(2)] : [pullRequest(2)],
  );
  await refresh;
  assert.deepEqual(h.github.runs, [
    run(failing === "github_workflow_runs" ? 1 : 2),
  ]);
  assert.deepEqual(h.github.pullRequests, [
    pullRequest(failing === "github_pull_requests" ? 1 : 2),
  ]);
  assert.match(h.github.error, /Permission denied/);
  assert.match(
    h.github.error,
    failing === "github_workflow_runs" ? /Workflow runs:/ : /Pull requests:/,
  );
  assert.equal(h.github.loading, false);

  const recovered = h.controller.refresh("/a");
  await h.status("/a");
  h.request("github_workflow_runs", "/a").resolve([run(3)]);
  h.request("github_pull_requests", "/a").resolve([pullRequest(3)]);
  await recovered;
  assert.equal(h.github.error, undefined);
  assert.deepEqual(h.github.runs, [run(3)]);
}

// A slow status response from a previous workspace must not publish data,
// clear the new workspace's spinner, or start either old repository list.
{
  const h = harness();
  h.setWorkspace("/a");
  const stale = h.controller.refresh("/a");
  h.setWorkspace("/b");
  const active = h.controller.refresh("/b");
  const before = h.actions.length;
  await h.status("/a");
  await stale;
  assert.equal(h.actions.length, before);
  assert.equal(h.github.loading, true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.controller.refresh("/b"), active);

  const calls = h.requests.length;
  await h.controller.refresh("/a");
  assert.equal(
    h.requests.length,
    calls,
    "Old mutation refresh cannot reactivate a repo",
  );
  await h.status("/b");
  h.request("github_workflow_runs", "/b").resolve([run(2)]);
  h.request("github_pull_requests", "/b").resolve([pullRequest(2)]);
  await active;
  assert.equal(h.github.availability.repository, "/b");
}

// Switching after status but before the lists finish discards both successes
// and failures. Old completion must also leave the new in-flight dedup intact.
{
  const h = harness();
  h.setWorkspace("/a");
  const stale = h.controller.refresh("/a");
  await h.status("/a");
  h.setWorkspace("/b");
  const active = h.controller.refresh("/b");
  const before = h.actions.length;
  h.request("github_workflow_runs", "/a").resolve([run(1)]);
  h.request("github_pull_requests", "/a").reject(new Error("Old failure"));
  await stale;
  assert.equal(h.actions.length, before);
  assert.equal(h.github.loading, true);
  assert.equal(h.controller.refresh("/b"), active);
  await h.status("/b", { ...availability("/b"), available: false });
  await active;
}

// A post-mutation forced refresh must not join a pre-mutation read. Its old
// response cannot overwrite the new data, spinner, error, or in-flight slot.
{
  const h = harness();
  h.setWorkspace("/a");
  const stale = h.controller.refresh("/a");
  await h.status("/a");
  const active = h.controller.refresh("/a", { force: true });
  assert.notEqual(active, stale);
  assert.equal(h.controller.refresh("/a"), active);
  const before = h.actions.length;
  h.request("github_workflow_runs", "/a").resolve([run(1)]);
  h.request("github_pull_requests", "/a").reject(new Error("Old read"));
  await stale;
  assert.equal(h.actions.length, before);
  assert.equal(h.github.loading, true);
  assert.equal(h.controller.refresh("/a"), active);
  await h.status("/a");
  h.request("github_workflow_runs", "/a").resolve([run(2)]);
  h.request("github_pull_requests", "/a").resolve([pullRequest(2)]);
  await active;
  assert.deepEqual(h.github.runs, [run(2)]);
  assert.equal(h.github.error, undefined);
  assert.equal(h.github.loading, false);
}

// A forced refresh also supersedes an availability probe. A stale caller from
// another workspace cannot use force to invalidate the active refresh.
{
  const h = harness();
  h.setWorkspace("/a");
  const stale = h.controller.refresh("/a");
  const oldStatus = h.request("github_status", "/a");
  const active = h.controller.refresh("/a", { force: true });
  const before = h.actions.length;
  await h.controller.refresh("/b", { force: true });
  oldStatus.reject(new Error("Old probe"));
  await stale;
  assert.equal(h.actions.length, before);
  assert.equal(h.controller.refresh("/a"), active);
  await h.status("/a", { ...availability("/a"), available: false });
  await active;
}

// Workspace identity alone is insufficient when a user switches A -> B -> A.
{
  const h = harness();
  h.setWorkspace("/a");
  const stale = h.controller.refresh("/a");
  const firstStatus = h.request("github_status", "/a");
  h.setWorkspace("/b");
  h.setWorkspace("/a");
  const active = h.controller.refresh("/a");
  assert.notEqual(active, stale);
  const before = h.actions.length;
  firstStatus.reject(new Error("Old A failure"));
  await stale;
  assert.equal(h.actions.length, before);
  assert.equal(h.controller.refresh("/a"), active);
  await h.status("/a", { ...availability("/a"), available: false });
  await active;
}

// Status failures settle loading and allow recovery; closing the workspace
// invalidates a pending probe and prevents background requests with no root.
{
  const h = harness();
  h.setWorkspace("/a");
  const failed = h.controller.refresh("/a");
  h.request("github_status", "/a").reject(new Error("Offline"));
  await failed;
  assert.equal(h.github.loading, false);
  assert.equal(h.github.error, "Offline");
  const pending = h.controller.refresh("/a");
  assert.equal(h.github.error, undefined);
  h.setWorkspace(undefined);
  const before = h.actions.length;
  await h.status("/a");
  await pending;
  await h.controller.refresh("/a");
  await h.controller.refresh("");
  assert.equal(h.actions.length, before);
  assert.equal(h.requests.length, 2);
}

// Detail/log requests are latest-only within their own channel. Collapsing a
// run uses beginRequest without issuing a request, invalidating its old detail.
{
  const h = harness();
  h.setWorkspace("/a");
  const scope = h.controller.captureWorkspace("/a");
  const detail1 = h.controller.beginRequest("/a", "detail");
  const logs1 = h.controller.beginRequest("/a", "logs");
  const detail2 = h.controller.beginRequest("/a", "detail");
  assert.equal(detail1(), false);
  assert.equal(detail2(), true);
  assert.equal(logs1(), true);
  assert.equal(h.controller.beginRequest("/b", "detail")(), false);
  assert.equal(detail2(), true);
  h.controller.beginRequest("/a", "detail");
  assert.equal(detail2(), false);
  const logs2 = h.controller.beginRequest("/a", "logs");
  assert.equal(logs1(), false);
  assert.equal(logs2(), true);
  h.setWorkspace("/b");
  h.setWorkspace("/a");
  assert.equal(scope(), false);
  assert.equal(logs2(), false);
}

// Reducer guards are a second boundary: a late result cannot reopen a
// collapsed run, replace another run's detail, or attach logs to that run.
{
  const h = harness();
  h.setWorkspace("/a");
  h.dispatch({ type: "github-select-run", runId: 1 });
  h.dispatch({
    type: "github-set-run-detail",
    detail: { run: run(1), jobs: [] },
  });
  h.dispatch({ type: "github-set-run-logs", runId: 1, logs: "first" });
  assert.equal(h.github.runDetail.run.id, 1);
  assert.equal(h.github.runLogs, "first");
  h.dispatch({ type: "github-select-run", runId: 2 });
  h.dispatch({
    type: "github-set-run-detail",
    detail: { run: run(1), jobs: [] },
  });
  h.dispatch({ type: "github-set-run-logs", runId: 1, logs: "stale" });
  assert.equal(h.github.selectedRunId, 2);
  assert.equal(h.github.runDetail, undefined);
  assert.equal(h.github.runLogs, undefined);
  h.dispatch({ type: "github-select-run", runId: undefined });
  h.dispatch({
    type: "github-set-run-detail",
    detail: { run: run(2), jobs: [] },
  });
  assert.equal(h.github.selectedRunId, undefined);
  assert.equal(h.github.runDetail, undefined);
  h.dispatch({ type: "github-set-runs", runs: [run(1)] });
  h.dispatch({ type: "github-error", error: "Old error" });
  h.setWorkspace("/b");
  assert.deepEqual(h.github, createInitialWorkbenchState().ide.github);
}

// AllSettled also handles a synchronous adapter error without skipping the
// other endpoint or turning a refresh into an unhandled rejection.
{
  const actions = [];
  const controller = createGithubRefreshController({
    dispatch: (action) => actions.push(action),
    invoke(command) {
      if (command === "github_status") {
        return Promise.resolve(availability("/a"));
      }
      if (command === "github_workflow_runs") {
        throw new Error("Adapter failed");
      }
      return Promise.resolve([pullRequest(4)]);
    },
  });
  controller.setWorkspace("/a");
  await controller.refresh("/a");
  assert.ok(
    actions.some(
      (action) =>
        action.type === "github-set-pull-requests" &&
        action.pullRequests[0].number === 4,
    ),
  );
  assert.match(
    actions.findLast((action) => action.type === "github-error").error,
    /Adapter failed/,
  );
  assert.deepEqual(actions.at(-1), { type: "github-loading", loading: false });
}

console.log("GitHub reliability checks passed.");
