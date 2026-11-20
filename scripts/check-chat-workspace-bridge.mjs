import assert from "node:assert/strict";
import { workspaceContextWithLiveEditor } from "../apps/desktop/src/workspace-context-bridge.ts";
import { refreshOpenEditorBuffers } from "../apps/desktop/src/refresh-open-editor-buffers.ts";
import { createInitialWorkbenchState, workbenchReducer } from "../packages/ui/src/workbench-state.ts";

const buffer = (path, content = "before", hash = "old") => ({
  path, content, savedContent: content, contentHash: hash, sizeBytes: content.length,
  truncated: false, status: "ready", updatedAt: "2026-11-17T00:00:00Z",
});
const context = { schema: "gyro.workspace-context.v1", workspaceKey: "/project",
  revision: 0, capturedAt: "2026-11-17T00:00:00Z", visibleTabs: [], buffers: [], diagnostics: [], testFailures: [] };
const tabs = Array.from({ length: 65 }, (_, i) => `/project/${i}.ts`);
const buffers = Object.fromEntries(tabs.map(path => [path, buffer(path)]));
buffers[tabs[64]].content = "unsaved";
const snapshot = workspaceContextWithLiveEditor(context, tabs[0], buffers, undefined, tabs);
assert.equal(snapshot.buffersComplete, false, "omitted dirty tabs must fail closed");
assert.equal(snapshot.buffers.length, 64);
const next = workspaceContextWithLiveEditor(context, tabs[64], buffers, undefined, tabs);
assert(next.revision > snapshot.revision);
assert(next.buffers.some(value => value.path === "64.ts" && value.dirty));

let state = createInitialWorkbenchState();
for (const path of ["/project/a.ts", "/project/b.ts"])
  state = workbenchReducer(state, { type: "ide-upsert-buffer", buffer: buffer(path) });
const focused = state.ide.activePath;
await refreshOpenEditorBuffers({
  paths: ["/project/a.ts"],
  getBuffer: path => state.ide.buffers[path],
  cancelled: () => false,
  stat: async () => ({ contentHash: "new" }),
  read: async path => buffer(path, "agent edit", "new"),
  apply: (before, value) => { state = workbenchReducer(state, { type: "ide-refresh-buffer", before, buffer: value }); },
  conflict: () => assert.fail("clean background buffer must refresh"),
});
assert.equal(state.ide.buffers["/project/a.ts"].content, "agent edit");
assert.equal(state.ide.activePath, focused, "refresh must not steal focus");

let applied = false;
await refreshOpenEditorBuffers({
  paths: ["/project/a.ts"],
  getBuffer: path => state.ide.buffers[path],
  cancelled: () => false,
  stat: async () => ({ contentHash: "newer" }),
  read: async path => {
    state = workbenchReducer(state, { type: "ide-update-buffer", path, content: "typing during read" });
    return buffer(path, "another agent edit", "newer");
  },
  apply: () => { applied = true; },
  conflict: () => assert.fail("buffer started clean"),
});
assert.equal(applied, false);
assert.equal(state.ide.buffers["/project/a.ts"].content, "typing during read");
const before = buffer("/project/a.ts", "agent edit", "new");
const protectedState = workbenchReducer(state, { type: "ide-refresh-buffer", before, buffer: buffer(before.path, "late disk read", "late") });
assert.equal(protectedState, state, "reducer also rejects a late refresh");

const restoredPath = "/project/b.ts";
state = workbenchReducer(state, {
  type: "ide-mark-buffer-error", path: restoredPath, error: "File is missing from disk.",
});
await refreshOpenEditorBuffers({
  paths: [restoredPath],
  getBuffer: (path) => state.ide.buffers[path],
  cancelled: () => false,
  stat: async () => ({ contentHash: "old" }),
  read: async (path) => buffer(path),
  apply: (before, next) => {
    state = workbenchReducer(state, { type: "ide-refresh-buffer", before, buffer: next });
  },
  conflict: () => assert.fail("a restored clean buffer must recover even with identical content"),
});
assert.equal(state.ide.buffers[restoredPath].status, "ready");

state = workbenchReducer(state, { type: "sync-diff-event", path: "a.ts", message: "preview", lines: [{ number: 1, kind: "added", content: "+exact proposed edit" }] });
assert.equal(state.diffReview.files.find(file => file.path === "a.ts").lines.length, 1);
state = workbenchReducer(state, { type: "sync-diff-event", path: "a.ts", message: "new proposal" });
assert.equal(state.diffReview.files.find(file => file.path === "a.ts").lines.length, 0, "a new proposal cannot retain an older preview");
state = workbenchReducer(state, { type: "sync-diff-event", path: "a.ts", proposalId: "new", message: "new proposal" });
state = workbenchReducer(state, { type: "set-diff-preview", path: "a.ts", proposalId: "old", lines: [{ number: 1, kind: "added", content: "+obsolete" }] });
assert.equal(state.diffReview.files.find(file => file.path === "a.ts").lines.length, 0, "a late preview cannot populate a different proposal");
state = workbenchReducer(state, { type: "set-diff-preview", path: "a.ts", proposalId: "new", lines: [{ number: 1, kind: "added", content: "+current" }] });
assert.equal(state.diffReview.files.find(file => file.path === "a.ts").additions, 1);
state = workbenchReducer(state, { type: "sync-diff-event", path: "a.ts", proposalId: "next", message: "next proposal" });
assert.equal(state.diffReview.files.find(file => file.path === "a.ts").countsKnown, false);
assert.equal(state.diffReview.files.find(file => file.path === "a.ts").additions, 0);
console.log("chat/workspace bridge regression checks passed");
