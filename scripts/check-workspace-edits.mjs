import assert from "node:assert/strict";
import {
  canonicalWorkspaceEditUri,
  prepareWorkspaceEdit,
  workspaceEditTargetUris,
} from "../apps/desktop/src/editor/workspace-edits.ts";
import {
  createInitialWorkbenchState,
  editorBufferRecoveryCapacity,
  persistableDirtyEditorBuffers,
  prepareEditorBufferBatch,
  sanitizeStoredIdeState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

const uri = "file:///workspace/main.ts";
const secondUri = "file:///workspace/side.ts";
const snapshot = {
  uri,
  path: "/workspace/main.ts",
  content: "😀 old old\r\nnext\n",
  version: 7,
  diskHash: "disk-main",
};
const side = {
  uri: secondUri,
  path: "/workspace/side.ts",
  content: "old",
  version: 3,
  diskHash: "disk-side",
};
const snapshots = { [uri]: snapshot, [secondUri]: side };
const textEdit = (line, start, end, newText) => ({
  range: { start: { line, character: start }, end: { line, character: end } },
  newText,
});
const edit = {
  changes: {
    [uri]: [
      textEdit(0, 7, 10, "new"),
      textEdit(0, 3, 6, "new"),
      textEdit(1, 0, 4, "then"),
    ],
    [secondUri]: [textEdit(0, 0, 3, "new")],
  },
};
const beforeSnapshots = structuredClone(snapshots);
const prepared = prepareWorkspaceEdit(edit, snapshots);
assert.deepEqual(
  snapshots,
  beforeSnapshots,
  "Planning must not mutate snapshots.",
);
assert.equal(prepared.editCount, 4);
assert.equal(prepared.files[0].before, snapshot.content);
assert.equal(
  prepared.files[0].after,
  "😀 new new\r\nthen\n",
  "UTF-16 positions and CRLF must survive.",
);
assert.equal(prepared.files[0].diskHash, "disk-main");
assert.equal(prepared.files[0].version, 7);
assert.equal(prepared.files[1].after, "new");
assert.deepEqual(workspaceEditTargetUris(edit), [uri, secondUri]);
assert.equal(
  canonicalWorkspaceEditUri("file://localhost/workspace/a%20b%23.ts"),
  "file:///workspace/a%20b%23.ts",
);

const documentEdit = (target, edits, version = null) => ({
  textDocument: { uri: target, version },
  edits,
});
assert.equal(
  prepareWorkspaceEdit(
    {
      documentChanges: [
        documentEdit(secondUri, [textEdit(0, 0, 3, "new")], 3),
        documentEdit(secondUri, [textEdit(0, 0, 3, "latest")], 3),
      ],
    },
    snapshots,
  ).files[0].after,
  "latest",
  "Ordered documentChanges apply in order.",
);
assert.equal(
  prepareWorkspaceEdit(
    {
      changes: {
        [secondUri]: [
          textEdit(0, 0, 0, "first"),
          textEdit(0, 0, 0, "second"),
          textEdit(0, 0, 3, "final"),
        ],
      },
    },
    snapshots,
  ).files[0].after,
  "firstsecondfinal",
  "Same-position insertions preserve LSP order.",
);
assert.equal(
  prepareWorkspaceEdit(
    { changes: { [secondUri]: [textEdit(0, 0, 3, "old")] } },
    snapshots,
  ).files.length,
  0,
);

for (const invalid of [
  null,
  {},
  { changes: [] },
  { changes: { [uri]: {} } },
  { changes: { "https://example.org/a.ts": [] } },
  { changes: { "file:///workspace/a%00.ts": [] } },
  { changes: { "file:///workspace/missing.ts": [] } },
  { changes: { [uri]: [textEdit(0, 1, 2, "bad")] } },
  { changes: { [uri]: [textEdit(0, 0, 11, "bad")] } },
  { changes: { [uri]: [textEdit(-1, 0, 1, "bad")] } },
  { changes: { [uri]: [textEdit(0, 3.5, 6, "bad")] } },
  { changes: { [uri]: [textEdit(10, 0, 0, "bad")] } },
  { changes: { [uri]: [textEdit(0, 6, 3, "bad")] } },
  { changes: { [uri]: [textEdit(0, 3, 6, "one"), textEdit(0, 5, 8, "two")] } },
  { changes: { [uri]: [{ range: {}, newText: "bad" }] } },
  { documentChanges: [documentEdit(uri, [textEdit(0, 3, 6, "new")], 6)] },
  { documentChanges: [documentEdit(uri, [], "7")] },
  {
    changes: { [uri]: [] },
    documentChanges: [{ kind: "create", uri: secondUri }],
  },
  {
    changes: { [uri]: [] },
    documentChanges: [{ kind: "rename", oldUri: uri, newUri: secondUri }],
  },
  { changes: { [uri]: [] }, documentChanges: [{ kind: "delete", uri }] },
  { changes: { [uri]: [], "file://localhost/workspace/main.ts": [] } },
])
  assert.throws(
    () => prepareWorkspaceEdit(invalid, snapshots),
    "Malformed or unsupported edits must reject the whole plan.",
  );
assert.throws(() =>
  workspaceEditTargetUris({ documentChanges: [{ kind: "delete", uri }] }),
);

const makeBuffer = (
  path,
  content,
  savedContent = content,
  contentHash = "hash",
) => ({
  path,
  content,
  savedContent,
  contentHash,
  sizeBytes: content.length,
  truncated: false,
  status: content === savedContent ? "ready" : "dirty",
  updatedAt: "2026-10-11T00:00:00.000Z",
});
let state = createInitialWorkbenchState();
const main = makeBuffer(snapshot.path, snapshot.content);
state = workbenchReducer(state, { type: "ide-upsert-buffer", buffer: main });
const original = state;
const updates = [
  {
    path: main.path,
    expectedContent: main.content,
    expectedHash: "hash",
    expectedSavedContent: main.savedContent,
    buffer: makeBuffer(main.path, "renamed", main.savedContent),
  },
  {
    path: side.path,
    buffer: makeBuffer(side.path, "renamed", side.content, side.diskHash),
  },
];
const changed = workbenchReducer(original, {
  type: "ide-apply-buffer-batch",
  updates,
});
assert.equal(changed.ide.buffers[main.path].content, "renamed");
assert.equal(changed.ide.buffers[side.path].status, "dirty");
assert.equal(
  changed.ide.tabs.length,
  original.ide.tabs.length,
  "Background edits must not create tabs.",
);
assert.equal(changed.ide.activePath, original.ide.activePath);
assert.equal(changed.activeDestination, original.activeDestination);
assert.equal(
  changed.ide.layout.activeGroupId,
  original.ide.layout.activeGroupId,
);
assert.deepEqual(
  changed.ide.layout.groups.map((group) => group.activePath),
  original.ide.layout.groups.map((group) => group.activePath),
);
assert.equal(
  changed.ide.tabs.find((tab) => tab.path === main.path).dirty,
  true,
);
assert.equal(
  changed.ide.layout.groups[0].tabs.find((tab) => tab.path === main.path).dirty,
  true,
);

for (const rejected of [
  [updates[0], { ...updates[1], expectedContent: "not present" }],
  [{ ...updates[0], expectedHash: "stale hash" }, updates[1]],
  [{ ...updates[0], expectedSavedContent: "stale baseline" }, updates[1]],
  [updates[0], updates[0]],
  [
    {
      ...updates[0],
      buffer: { ...updates[0].buffer, path: "/workspace/wrong.ts" },
    },
  ],
]) {
  assert.throws(() => prepareEditorBufferBatch(original.ide.buffers, rejected));
  assert.equal(
    workbenchReducer(original, {
      type: "ide-apply-buffer-batch",
      updates: rejected,
    }),
    original,
    "A stale target must reject all updates atomically.",
  );
}

const restored = sanitizeStoredIdeState(
  {
    ...changed.ide,
    buffers: persistableDirtyEditorBuffers(changed.ide.buffers),
  },
  createInitialWorkbenchState().ide,
);
assert.equal(
  restored.buffers[side.path].content,
  "renamed",
  "Background dirty buffers must recover without tabs.",
);
assert.equal(
  restored.tabs.some((tab) => tab.path === side.path),
  false,
);
const noLayout = sanitizeStoredIdeState(
  { ...changed.ide, layout: { ...changed.ide.layout, restoreOnLaunch: false } },
  createInitialWorkbenchState().ide,
);
assert.equal(noLayout.tabs.length, 0);
assert.equal(
  noLayout.buffers[side.path].content,
  "renamed",
  "Layout preference must not discard dirty recovery.",
);
assert.equal(editorBufferRecoveryCapacity(changed.ide.buffers).ok, true);
const tooMany = Array.from({ length: 31 }, (_, index) => ({
  path: `/workspace/${index}.ts`,
  buffer: makeBuffer(`/workspace/${index}.ts`, "new", "old"),
}));
assert.equal(
  workbenchReducer(createInitialWorkbenchState(), {
    type: "ide-apply-buffer-batch",
    updates: tooMany,
  }).ide.buffers["/workspace/0.ts"],
  undefined,
);
assert.throws(() => prepareEditorBufferBatch({}, tooMany), /30/);
assert.throws(
  () =>
    persistableDirtyEditorBuffers(
      Object.fromEntries(tooMany.map((update) => [update.path, update.buffer])),
    ),
  /30/,
);
assert.throws(
  () =>
    prepareEditorBufferBatch({}, [
      {
        path: "/workspace/huge.ts",
        buffer: makeBuffer("/workspace/huge.ts", "x".repeat(500_001), ""),
      },
    ]),
  /too large/,
);
assert.throws(
  () =>
    prepareEditorBufferBatch(
      {},
      Array.from({ length: 3 }, (_, index) => ({
        path: `/workspace/large-${index}.ts`,
        buffer: makeBuffer(
          `/workspace/large-${index}.ts`,
          "x".repeat(340_000),
          "",
        ),
      })),
    ),
  /limit/,
);

const undone = workbenchReducer(changed, {
  type: "ide-apply-buffer-batch",
  updates: [
    {
      path: main.path,
      expectedContent: "renamed",
      expectedHash: "hash",
      buffer: main,
    },
    {
      path: side.path,
      expectedContent: "renamed",
      expectedHash: side.diskHash,
      buffer: null,
    },
  ],
});
assert.equal(undone.ide.buffers[main.path].content, main.content);
assert.equal(undone.ide.buffers[side.path], undefined);
assert.equal(
  undone.ide.tabs.find((tab) => tab.path === main.path).dirty,
  false,
);
assert.equal(
  undone.ide.layout.groups[0].tabs.find((tab) => tab.path === main.path).dirty,
  false,
);
const newer = workbenchReducer(changed, {
  type: "ide-update-buffer",
  path: main.path,
  content: "typed later",
});
assert.equal(
  workbenchReducer(newer, {
    type: "ide-apply-buffer-batch",
    updates: [{ path: main.path, expectedContent: "renamed", buffer: main }],
  }),
  newer,
  "Undo must never overwrite later typing.",
);

const savedWhileTyping = workbenchReducer(newer, {
  type: "ide-mark-buffer-saved",
  path: main.path,
  content: "renamed",
  contentHash: "new-disk-hash",
  sizeBytes: 7,
});
assert.equal(savedWhileTyping.ide.buffers[main.path].content, "typed later");
assert.equal(savedWhileTyping.ide.buffers[main.path].savedContent, "renamed");
assert.equal(
  savedWhileTyping.ide.buffers[main.path].contentHash,
  "new-disk-hash",
);
assert.equal(savedWhileTyping.ide.buffers[main.path].status, "dirty");
assert.equal(
  savedWhileTyping.ide.tabs.find((tab) => tab.path === main.path).dirty,
  true,
);
const saved = workbenchReducer(changed, {
  type: "ide-mark-buffer-saved",
  path: main.path,
  content: "renamed",
  contentHash: "new-disk-hash",
  sizeBytes: 7,
});
assert.equal(saved.ide.buffers[main.path].status, "saved");
assert.equal(saved.ide.tabs.find((tab) => tab.path === main.path).dirty, false);
assert.equal(
  workbenchReducer(saved, {
    type: "ide-apply-buffer-batch",
    updates: [
      {
        path: main.path,
        expectedContent: "renamed",
        expectedHash: "hash",
        expectedSavedContent: main.savedContent,
        buffer: main,
      },
    ],
  }),
  saved,
  "Undo must reject a changed save baseline.",
);
const tabWithoutBuffer = workbenchReducer(createInitialWorkbenchState(), {
  type: "ide-open-tab",
  tab: { path: side.path, title: "side.ts", dirty: false },
});
const filledTab = workbenchReducer(tabWithoutBuffer, {
  type: "ide-apply-buffer-batch",
  updates: [{ path: side.path, buffer: makeBuffer(side.path, "new", "old") }],
});
const removed = workbenchReducer(filledTab, {
  type: "ide-apply-buffer-batch",
  updates: [{ path: side.path, expectedContent: "new", buffer: null }],
});
assert.equal(removed.ide.buffers[side.path], undefined);
assert.equal(removed.ide.tabs[0].dirty, false);
assert.equal(removed.ide.layout.groups[0].tabs[0].dirty, false, "Undo deleting an introduced buffer must clear the surviving tab's dirty decoration.");

// A rename can create dirty buffers without adding tabs. Closing an unrelated
// group must never remove those background drafts from recovery or Save All.
const splitWithBackground = workbenchReducer(changed, {
  type: "ide-split-group", direction: "right",
});
const closingGroupId = splitWithBackground.ide.layout.activeGroupId;
const closingPath = "/workspace/close-only.ts";
const withOwnedTab = workbenchReducer(splitWithBackground, {
  type: "ide-upsert-buffer", buffer: makeBuffer(closingPath, "close me"),
});
const afterGroupClose = workbenchReducer(withOwnedTab, {
  type: "ide-close-group", groupId: closingGroupId,
});
assert.equal(afterGroupClose.ide.buffers[side.path].content, "renamed",
  "Closing a split must preserve a dirty background rename target with no tab.");
assert.equal(afterGroupClose.ide.buffers[main.path].content, "renamed",
  "Closing a split must preserve buffers still open in another group.");
assert.equal(afterGroupClose.ide.buffers[closingPath], undefined,
  "Closing a group's sole file must still release its owned buffer.");
assert.equal(afterGroupClose.ide.tabs.some((tab) => tab.path === side.path), false);
assert.equal(afterGroupClose.ide.layout.groups.length, 1);
assert.equal(persistableDirtyEditorBuffers(afterGroupClose.ide.buffers)[side.path].content, "renamed");
const afterLastGroupClose = workbenchReducer(afterGroupClose, {
  type: "ide-close-group", groupId: afterGroupClose.ide.layout.activeGroupId,
});
assert.equal(afterLastGroupClose.ide.buffers[side.path].content, "renamed",
  "Closing the last visible group must still preserve background drafts.");
console.log(
  "Workspace edit checks passed: UTF-16, ordered edits, versions, resource rejection, atomic buffers, recovery, undo and save races.",
);
