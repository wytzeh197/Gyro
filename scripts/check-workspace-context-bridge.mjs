// The chat bridge lists every open tab and holds complete unsaved text only
// while the snapshot stays inside the capability evidence limit.
// Run with: node --experimental-strip-types scripts/check-workspace-context-bridge.mjs
import assert from "node:assert/strict";
import {
  WORKSPACE_EVIDENCE_BYTE_LIMIT,
  workspaceContextWithLiveEditor,
} from "../apps/desktop/src/workspace-context-bridge.ts";

const root = "/repo";

function context(extra = {}) {
  return {
    schema: "gyro.workspace-context.v1",
    workspaceKey: root,
    revision: 1,
    capturedAt: "2026-10-20T00:00:00.000Z",
    availability: "available",
    activePath: undefined,
    activeView: undefined,
    visibleTabs: [],
    selection: undefined,
    buffers: [],
    diagnostics: [],
    testFailures: [],
    ...extra,
  };
}

function buffer(path, content, saved = content, extra = {}) {
  return {
    path,
    content,
    savedContent: saved,
    contentHash: "hash",
    updatedAt: "2026-10-20T00:00:01.000Z",
    ...extra,
  };
}

function bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

const active = `${root}/src/active.ts`;
const dirty = `${root}/src/dirty.ts`;
const clean = `${root}/src/clean.ts`;
const outside = "/other/skip.ts";

{
  const snapshot = workspaceContextWithLiveEditor(
    context(),
    active,
    {
      [active]: buffer(active, "active unsaved", "active saved"),
      [dirty]: buffer(dirty, "dirty unsaved", "dirty saved"),
      [clean]: buffer(clean, "clean text"),
    },
    {
      path: active,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
      text: "active",
    },
    [clean, active, dirty, outside, active],
  );
  assert.deepEqual(
    snapshot.visibleTabs,
    ["src/clean.ts", "src/active.ts", "src/dirty.ts"],
    "open project tabs are listed once, in order, and outside files are dropped",
  );
  assert.equal(snapshot.activePath, "src/active.ts");
  assert.equal(snapshot.buffers.length, 3);
  assert.equal(snapshot.buffers[1].content, "active unsaved");
  assert.equal(snapshot.buffers[1].dirty, true);
  assert.equal(snapshot.buffers[1].truncated, undefined);
  assert.equal(snapshot.buffers[2].content, "dirty unsaved");
  assert.equal(snapshot.buffers[2].dirty, true);
  assert.equal(snapshot.buffers[0].content, undefined);
  assert.equal(snapshot.buffers[0].dirty, false);
  assert.equal(snapshot.buffers[0].path, "src/clean.ts");
  assert.equal(snapshot.selection?.text, "active");
  assert.equal(snapshot.selection?.path, "src/active.ts");
  assert.ok(bytes(snapshot) <= WORKSPACE_EVIDENCE_BYTE_LIMIT);
}

{
  const big = "x".repeat(48_001);
  const snapshot = workspaceContextWithLiveEditor(
    context(),
    active,
    { [active]: buffer(active, big, "saved") },
    undefined,
    [active],
  );
  assert.equal(
    snapshot.buffers[0].content,
    big,
    "a buffer past the old 48k clip is held in full when it fits",
  );
  assert.equal(snapshot.buffers[0].truncated, undefined);
}

{
  const huge = "y".repeat(200_000);
  const small = "kept dirty";
  const snapshot = workspaceContextWithLiveEditor(
    context({
      diagnostics: Array.from({ length: 20 }, (_, index) => ({
        path: "src/active.ts",
        message: `d${index}`,
      })),
    }),
    active,
    {
      [active]: buffer(active, huge, "saved-active"),
      [dirty]: buffer(dirty, small, "saved-dirty"),
      [`${root}/src/also-dirty.ts`]: buffer(
        `${root}/src/also-dirty.ts`,
        huge,
        "saved-also",
      ),
    },
    {
      path: active,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
      text: "z".repeat(200_000),
    },
    [active, dirty, `${root}/src/also-dirty.ts`],
  );
  assert.equal(snapshot.buffers[0].content, undefined);
  assert.equal(snapshot.buffers[0].dirty, true);
  assert.equal(snapshot.buffers[0].truncated, undefined);
  assert.equal(snapshot.buffers[1].content, small);
  assert.equal(snapshot.buffers[2].content, undefined);
  assert.equal(snapshot.selection, undefined);
  assert.equal(snapshot.diagnostics.length, 20);
  assert.ok(bytes(snapshot) <= WORKSPACE_EVIDENCE_BYTE_LIMIT);
}

{
  const snapshot = workspaceContextWithLiveEditor(
    context(),
    undefined,
    { [clean]: buffer(clean, "on disk") },
    undefined,
    [clean],
  );
  assert.equal(snapshot.activePath, undefined);
  assert.deepEqual(snapshot.visibleTabs, ["src/clean.ts"]);
  assert.equal(snapshot.buffers[0].content, undefined);
  assert.equal(snapshot.buffers[0].documentVersion, "2026-10-20T00:00:01.000Z");
}

{
  const snapshot = workspaceContextWithLiveEditor(
    context(),
    active,
    {
      [active]: buffer(active, "partial", "saved", { truncated: true }),
    },
    undefined,
    [active],
  );
  assert.equal(snapshot.buffers[0].content, undefined);
  assert.equal(snapshot.buffers[0].truncated, true);
  assert.equal(snapshot.buffers[0].dirty, true);
}

console.log("workspace context bridge ok");
