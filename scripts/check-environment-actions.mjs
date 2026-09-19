import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { environmentActions } from "../packages/ui/src/environment-actions.ts";

const repo = (overrides = {}) => ({
  provider: "git",
  available: true,
  branch: "release/v0.1.0-alpha.48.8",
  upstream: undefined,
  ahead: 0,
  behind: 0,
  additions: 0,
  deletions: 0,
  statsPartial: false,
  files: [],
  ...overrides,
});

const file = (path) => ({
  path,
  state: "modified",
  staged: false,
  additions: 3,
  deletions: 1,
});

const byId = (sourceControl) =>
  Object.fromEntries(
    environmentActions(sourceControl).map((action) => [action.id, action]),
  );

// Every row explains itself. A greyed row with no reason is the gap these rows
// were added to close, so an empty detail is a failure in every state.
for (const state of [
  undefined,
  repo({ available: false }),
  repo(),
  repo({ files: [file("a.ts")] }),
  repo({ upstream: "origin/main", ahead: 2 }),
  repo({ upstream: "origin/main" }),
]) {
  for (const action of environmentActions(state)) {
    assert.ok(
      action.detail.trim().length > 0,
      `${action.id} must say why it is offered or blocked`,
    );
    assert.equal(
      Boolean(action.intent),
      action.enabled,
      `${action.id} carries an intent exactly when it is enabled`,
    );
  }
}

// Uncommitted work routes to Review, because a commit needs a message and the
// message field lives there. Running `commit` straight from the popover would
// either invent a second message field or commit with a stale one.
{
  const actions = byId(repo({ files: [file("a.ts"), file("b.ts")] }));
  assert.equal(actions["commit-or-push"].enabled, true);
  assert.equal(actions["commit-or-push"].detail, "2 files to commit");
  assert.deepEqual(actions["commit-or-push"].intent, { kind: "review" });
}

// One file reads as one file, not "1 files".
assert.equal(
  byId(repo({ files: [file("a.ts")] }))["commit-or-push"].detail,
  "1 file to commit",
);

// A branch with no upstream reports ahead: 0 because git has nothing to count
// against. Reading that as "nothing to push" would block the row at exactly the
// moment publishing is the point — this is the current alpha-48.8 branch.
{
  const actions = byId(repo());
  assert.equal(actions["commit-or-push"].enabled, true);
  assert.equal(actions["commit-or-push"].detail, "Publish this branch");
  assert.deepEqual(actions["commit-or-push"].intent, {
    kind: "git",
    actionId: "push",
  });
  assert.equal(actions["create-pull-request"].enabled, false);
  assert.equal(actions["create-pull-request"].detail, "Push the branch first");
}

// Committed but unpushed work pushes; a pull request would miss the commits.
{
  const actions = byId(repo({ upstream: "origin/main", ahead: 2 }));
  assert.deepEqual(actions["commit-or-push"].intent, {
    kind: "git",
    actionId: "push",
  });
  assert.equal(actions["commit-or-push"].detail, "2 commits to push");
  assert.equal(actions["create-pull-request"].enabled, false);
  assert.equal(
    actions["create-pull-request"].detail,
    "2 commits not pushed yet",
  );
}

// A published branch in sync is the one state where the pull request is real
// and there is nothing left to send.
{
  const actions = byId(repo({ upstream: "origin/main" }));
  assert.equal(actions["commit-or-push"].enabled, false);
  assert.equal(actions["commit-or-push"].detail, "Nothing to commit or push");
  assert.equal(actions["create-pull-request"].enabled, true);
  assert.deepEqual(actions["create-pull-request"].intent, {
    kind: "git",
    actionId: "open-pr",
  });
}

// Outside a repository neither row pretends to work.
for (const state of [undefined, repo({ available: false })]) {
  for (const action of environmentActions(state)) {
    assert.equal(action.enabled, false);
    assert.equal(action.detail, "No repository here");
  }
}

// The popover's readiness rule has to match the Review surface's git action
// strip: two places offering "push" must not disagree about whether it is
// possible. Both derive it from ahead > 0 || no upstream.
const workbenchState = readFileSync(
  new URL("../packages/ui/src/workbench-state.ts", import.meta.url),
  "utf8",
);
assert.ok(
  /sourceControl\.ahead > 0 \|\| !hasUpstream/.test(workbenchState),
  "Review's push readiness should still be ahead > 0 || no upstream",
);
const actionsModule = readFileSync(
  new URL("../packages/ui/src/environment-actions.ts", import.meta.url),
  "utf8",
);
assert.ok(
  /sourceControl\.ahead > 0 \|\| !sourceControl\.upstream/.test(actionsModule),
  "Environment's push readiness should match Review's",
);

// The rows have to be rendered, wired to the real git runner, and styled — a
// pure module nothing calls would pass every assertion above and ship nothing.
const surfaces = readFileSync(
  new URL("../packages/ui/src/surfaces.tsx", import.meta.url),
  "utf8",
);
assert.ok(
  surfaces.includes("environmentActions(sourceControl)"),
  "The Environment popover should render the derived action rows",
);
assert.ok(
  surfaces.includes("onRunGitAction={railDiffTools?.onRunGitAction}"),
  "Environment git rows should run the same actions the Review surface runs",
);
assert.ok(
  /action\.intent\?\.kind === "review" \|\| Boolean\(onRunGitAction\)/.test(
    surfaces,
  ),
  "A git row with no handler behind it should read as unavailable",
);
const styles = readFileSync(
  new URL("../packages/ui/src/styles.css", import.meta.url),
  "utf8",
);
for (const selector of [
  ".gyro-chat-environment-popover-actions {",
  ".gyro-chat-environment-popover-actions > button:disabled {",
]) {
  assert.ok(styles.includes(selector), `styles.css should define ${selector}`);
}

console.log("environment actions checks passed");
