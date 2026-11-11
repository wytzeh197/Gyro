import assert from "node:assert/strict";
import { resolveChatPaneClose } from "../apps/desktop/src/chat-pane-close.ts";
import {
  chatGridReducer,
  createInitialChatGridState,
} from "../packages/ui/src/workbench-state.ts";

const pane = (sessionId, workspacePath) => ({
  kind: "session",
  paneId: `pane:${sessionId}`,
  sessionId,
  workspacePath,
});
const first = pane("first", "/project/a");
const sibling = pane("sibling", "/project/a");
const other = pane("other", "/project/b");
let grid = createInitialChatGridState();
for (const [item, slotIndex] of [
  [first, 0],
  [sibling, 1],
  [other, 0],
]) {
  grid = chatGridReducer(grid, {
    type: "select-pane",
    projectKey: item.workspacePath,
    pane: item,
    slotIndex,
    mode: "replace",
  });
}

// A close confirmation opened in A must still close A after navigation to B.
const delayed = resolveChatPaneClose(grid, first);
assert.equal(delayed.projectKey, "/project/a");
assert.equal(delayed.isActiveProject, false);
assert.equal(delayed.nextPane, sibling);
const backgroundClosed = chatGridReducer(grid, {
  type: "close-pane",
  projectKey: delayed.projectKey,
  paneId: first.paneId,
});
assert.equal(backgroundClosed.activeProjectKey, "/project/b");
assert.equal(
  backgroundClosed.layouts["/project/b"],
  grid.layouts["/project/b"],
);
assert.equal(backgroundClosed.layouts["/project/a"].slots[0], sibling);
assert.equal(resolveChatPaneClose(backgroundClosed, first), undefined);

assert.equal(
  resolveChatPaneClose(grid, { ...first, sessionId: "replaced" }),
  undefined,
);
assert.equal(resolveChatPaneClose(grid, { paneId: "missing" }), undefined);
const active = resolveChatPaneClose(grid, other);
assert.equal(active.isActiveProject, true);
assert.equal(active.nextPane, undefined);

// Closing an unfocused pane preserves the focused draft and its saved text key.
const draft = {
  kind: "draft",
  paneId: "draft:a",
  draftKey: "draft-text:a",
  workspacePath: "/project/a",
};
grid = chatGridReducer(grid, {
  type: "select-pane",
  projectKey: "/project/a",
  pane: draft,
  slotIndex: 2,
  mode: "replace",
});
const closeUnfocused = resolveChatPaneClose(grid, first);
assert.equal(closeUnfocused.isActiveProject, true);
assert.equal(closeUnfocused.nextPane, draft);
const closeDraft = resolveChatPaneClose(grid, draft);
assert.equal(closeDraft.nextPane, first);

// One session can appear in its own layout and in a mixed-folder split.
// A delayed close still owns its specific pane, even after changing layouts.
const mixedGrid = chatGridReducer(grid, {
  type: "select-pane", projectKey: "/project/a", pane: other,
  slotIndex: 3, mode: "drop",
});
const mixedPane = mixedGrid.layouts["/project/a"].slots[3];
assert.notEqual(mixedPane.paneId, other.paneId);
assert.equal(resolveChatPaneClose(mixedGrid, mixedPane).projectKey, "/project/a");
const navigated = chatGridReducer(mixedGrid, { type: "activate-project", projectKey: "/project/b" });
assert.equal(resolveChatPaneClose(navigated, mixedPane).projectKey, "/project/a");
assert.equal(resolveChatPaneClose(navigated, other).projectKey, "/project/b");

console.log("chat close target checks passed");
