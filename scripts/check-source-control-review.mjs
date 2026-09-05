import assert from "node:assert/strict";
import {
  createInitialWorkbenchState,
  sanitizeStoredIdeState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

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
console.log("Source-control review tab lifecycle checks passed.");
