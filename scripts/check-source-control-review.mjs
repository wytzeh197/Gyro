import assert from "node:assert/strict";
import {
  createInitialWorkbenchState,
  sanitizeStoredIdeState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";
import {
  sourceControlTotals,
  sourceControlTotalsLabel,
  sourceControlTotalsScope,
} from "../packages/ui/src/source-control-stats.ts";

const reduce = (state, ...actions) => actions.reduce(workbenchReducer, state);
const initial = createInitialWorkbenchState();
const file = "/workspace/file.ts";
const review = (staged) => ({
  path: `gyro-diff:workspace:${staged ? "index" : "worktree"}:file.ts`,
  title: `file.ts (${staged ? "Index" : "Working Tree"})`,
  dirty: false,
  preview: true,
  sourceControlDiff: { workspacePath: "/workspace", path: "file.ts", staged },
});
const buffer = {
  path: file,
  content: "unsaved",
  savedContent: "saved",
  sizeBytes: 7,
  truncated: false,
  status: "dirty",
  updatedAt: new Date().toISOString(),
};
let state = reduce(
  initial,
  {
    type: "ide-open-tab",
    tab: { path: file, title: "file.ts", dirty: true, pinned: true },
  },
  { type: "ide-upsert-buffer", buffer },
  { type: "ide-open-tab", tab: review(false) },
  { type: "close-tool-panel" },
);
assert.equal(state.ide.activePath, review(false).path);
assert.equal(state.activeWorkspaceLayout, "code");
assert.equal(state.isToolPanelOpen, false);
assert.equal(state.ide.buffers[file].content, "unsaved");
assert.equal(state.ide.tabs.find((tab) => tab.path === file).dirty, true);
assert.deepEqual(
  state.ide.layout.groups[0].tabs.at(-1).sourceControlDiff,
  review(false).sourceControlDiff,
);

state = reduce(state, { type: "ide-open-tab", tab: review(true) });
assert.equal(
  state.ide.tabs.length,
  2,
  "An unpinned diff preview is replaced, never the dirty file",
);
assert.equal(state.ide.tabs.at(-1).sourceControlDiff.staged, true);
state = reduce(
  state,
  { type: "ide-pin-tab", path: review(true).path },
  { type: "ide-open-tab", tab: review(false) },
);
assert.equal(
  state.ide.tabs.length,
  3,
  "Pinned index and worktree comparisons remain distinct",
);
state = reduce(state, { type: "ide-close-tab", path: review(false).path });
assert.equal(state.ide.buffers[file].content, "unsaved");

const restored = sanitizeStoredIdeState(state.ide, initial.ide);
assert.ok(
  restored.tabs.every((tab) => !tab.path.startsWith("gyro-diff:")),
  "Review snapshots are ephemeral and must never reopen as disk files",
);
assert.ok(
  restored.layout.groups.every((group) =>
    group.tabs.every((tab) => !tab.path.startsWith("gyro-diff:")),
  ),
);
// --- One +/- pair per repository -------------------------------------------
// The Workspace sidebar and the chat Environment print the same slot. They used
// to fill it from different quantities — the branch against main, and the
// uncommitted working tree — and showed +487 -390 beside +335 -338 for the same
// repository at the same moment. Both resolve it here now.

const repo = (overrides) => ({
  provider: "git",
  available: true,
  ahead: 0,
  behind: 0,
  additions: 335,
  deletions: 338,
  statsPartial: false,
  files: [],
  ...overrides,
});

assert.deepEqual(
  sourceControlTotals(
    repo({
      comparedToMain: { additions: 487, deletions: 390, partial: false },
    }),
  ),
  { kind: "branch", additions: 487, deletions: 390 },
  "the branch against main is the headline figure, not the working tree",
);

assert.deepEqual(
  sourceControlTotals(repo({ comparedToMain: undefined })),
  { kind: "working-tree", additions: 335, deletions: 338 },
  "without a comparison the working tree stands in",
);
assert.equal(
  sourceControlTotalsScope(
    sourceControlTotals(repo({ comparedToMain: undefined })),
  ).includes("Uncommitted"),
  true,
  "and the fallback says what it measured rather than borrowing the branch's meaning",
);

assert.deepEqual(
  sourceControlTotals(
    repo({ comparedToMain: { additions: 487, deletions: 390, partial: true } }),
  ),
  { kind: "working-tree", additions: 335, deletions: 338 },
  "a partial comparison is not the branch total",
);
assert.deepEqual(
  sourceControlTotals(
    repo({
      statsPartial: true,
      comparedToMain: { additions: 0, deletions: 0, partial: true },
    }),
  ),
  { kind: "unavailable" },
  "with neither number complete the row admits it has no count",
);

assert.deepEqual(
  sourceControlTotals(
    repo({
      additions: 12,
      deletions: 3,
      comparedToMain: { additions: 0, deletions: 0, partial: false },
    }),
  ),
  { kind: "clean" },
  "Clean means the branch matches main, even with edits still in the working tree",
);
assert.deepEqual(
  sourceControlTotals(repo({ available: false })),
  { kind: "unavailable" },
  "a repository Gyro cannot read has no count to show",
);
assert.equal(sourceControlTotalsLabel({ kind: "clean" }), "Clean");

console.log("Source-control review tab lifecycle checks passed.");
