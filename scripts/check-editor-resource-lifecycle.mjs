import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";
import {
  createModelRetirement,
  installModelRetirement,
  retireEditorModels,
} from "../apps/desktop/src/editor/model-retirement.ts";
import { canonicalFileUri } from "../apps/desktop/src/editor/document-uri.ts";

const path = (index) => `/workspace/file-${index}.txt`;
const open = (state, target, options = {}) =>
  workbenchReducer(state, {
    type: "ide-open-tab",
    tab: {
      path: target,
      title: target,
      dirty: false,
      preview: true,
      ...options,
    },
  });
const buffer = (target, content = "saved") => ({
  path: target,
  content,
  savedContent: content,
  contentHash: target,
  sizeBytes: content.length,
  truncated: false,
  status: "ready",
  updatedAt: "2026-11-08T12:00:00Z",
});
const upsert = (state, value) =>
  workbenchReducer(state, { type: "ide-upsert-buffer", buffer: value });
let state = createInitialWorkbenchState();
for (let i = 0; i < 200; i++)
  state = upsert(open(state, path(i)), buffer(path(i), `Content ${i}`));
assert.equal(state.ide.tabs.length, 1);
assert.deepEqual(Object.keys(state.ide.buffers), [path(199)]);

// Preserve every form of user-owned text, including stale tab flags.
for (const status of ["dirty", "saving", "error"]) {
  let s = upsert(open(createInitialWorkbenchState(), path(0)), buffer(path(0)));
  s = {
    ...s,
    ide: {
      ...s.ide,
      buffers: {
        ...s.ide.buffers,
        [path(0)]: {
          ...s.ide.buffers[path(0)],
          status,
          content: status === "dirty" ? "unsaved" : "saved",
        },
      },
    },
  };
  const next = open(s, path(1));
  assert.equal(next.ide.buffers[path(0)], s.ide.buffers[path(0)]);
  assert.ok(next.ide.tabs.some((tab) => tab.path === path(0)));
}
let pinned = upsert(
  open(createInitialWorkbenchState(), path(0)),
  buffer(path(0)),
);
pinned = workbenchReducer(pinned, { type: "ide-pin-tab", path: path(0) });
pinned = upsert(open(pinned, path(1)), buffer(path(1)));
assert.equal(Object.keys(pinned.ide.buffers).length, 2);

let shared = upsert(
  open(createInitialWorkbenchState(), path(0)),
  buffer(path(0)),
);
const first = shared.ide.layout.groups[0];
shared = {
  ...shared,
  ide: {
    ...shared.ide,
    selection: {
      path: path(0),
      text: "keep selected",
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
    },
    layout: {
      ...shared.ide.layout,
      groups: [
        first,
        {
          ...first,
          id: "second",
          panes: [{ id: "second-pane", path: path(0) }],
        },
      ],
    },
  },
};
const split = upsert(open(shared, path(1)), buffer(path(1)));
assert.ok(
  split.ide.layout.groups[1].tabs.some((tab) => tab.path === path(0)),
  "Replacing one preview cannot close another split's tab",
);
assert.equal(split.ide.buffers[path(0)], shared.ide.buffers[path(0)]);
assert.equal(split.ide.selection, shared.ide.selection);
const closed = workbenchReducer(split, {
  type: "ide-close-tab",
  path: path(0),
  groupId: "second",
});
assert.equal(closed.ide.buffers[path(0)], undefined);
const background = workbenchReducer(shared, {
  type: "ide-open-tab",
  background: true,
  tab: { path: path(1), title: "background", preview: true, dirty: false },
});
assert.equal(background.ide.activePath, path(0));
assert.ok(background.ide.tabs.some((tab) => tab.path === path(0)));

// Execute the actual hook, with commits separated from render attempts.
const exports = {};
let ref;
let commit;
const hookCode = ts.transpileModule(
  readFileSync(
    new URL(
      "../apps/desktop/src/editor/use-editor-model-lifecycle.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;
runInNewContext(hookCode, {
  exports,
  require(id) {
    if (id === "react")
      return {
        useRef: (initial) => (ref ??= { current: initial }),
        useLayoutEffect: (fn) => {
          commit = fn;
        },
      };
    if (id === "./document-uri") return { canonicalFileUri };
    if (id === "./model-retirement") return { retireEditorModels };
    throw Error(id);
  },
});
const retirements = [];
installModelRetirement({
  retire: (uri, test) => retirements.push({ uri, test }),
  cancelAll() {},
});
exports.useEditorModelLifecycle(shared.ide);
commit();
exports.useEditorModelLifecycle(closed.ide);
assert.equal(
  retirements.length,
  0,
  "An abandoned render cannot dispose committed models",
);
commit();
assert.equal(retirements.length, 1);
assert.equal(retirements[0].uri, canonicalFileUri(path(0)));
assert.equal(retirements[0].test(), true);
exports.useEditorModelLifecycle(shared.ide);
commit();
assert.equal(
  retirements[0].test(),
  false,
  "A rapid reopen cancels stale retirement",
);
const beforeRead = open(createInitialWorkbenchState(), path(3));
assert.ok(
  exports.editorModelUris(beforeRead.ide).has(canonicalFileUri(path(3))),
  "Tabs own models before their read resolves",
);
const aliases = {
  ...beforeRead.ide,
  buffers: { "/workspace/../workspace/file-3.txt": buffer(path(3)) },
};
assert.equal(exports.editorModelUris(aliases).size, 1);

function signal() {
  const listeners = new Set();
  return {
    listeners,
    event: (fn) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    fire: () => [...listeners].forEach((fn) => fn()),
  };
}
function model() {
  const will = signal();
  return {
    disposed: false,
    disposals: 0,
    will,
    isDisposed() {
      return this.disposed;
    },
    onWillDispose: will.event,
    dispose() {
      assert.equal(this.disposed, false);
      this.disposed = true;
      this.disposals++;
      will.fire();
    },
  };
}
function owner(current) {
  const changed = signal(),
    disposed = signal();
  return {
    current,
    changed,
    disposed,
    onDidChangeModel: changed.event,
    onDidDispose: disposed.event,
    switch(next) {
      this.current = next;
      changed.fire();
    },
    close() {
      this.current = undefined;
      disposed.fire();
    },
  };
}
function fixture() {
  const models = new Map(),
    owners = [],
    tasks = new Map();
  let timer = 0;
  const retirement = createModelRetirement({
    find: (key) => models.get(key),
    owners: (m) => owners.filter((o) => o.current === m),
    schedule: (fn) => {
      tasks.set(++timer, fn);
      return timer;
    },
    cancel: (id) => tasks.delete(id),
  });
  return {
    models,
    owners,
    tasks,
    ...retirement,
    flush() {
      for (let i = 0; tasks.size; i++) {
        assert.ok(
          i < 20,
          "Retirement must not poll while an owner stays attached",
        );
        const next = [...tasks.entries()];
        tasks.clear();
        next.forEach(([, fn]) => fn());
      }
    },
  };
}
const f = fixture(),
  old = model(),
  left = owner(old),
  right = owner(old);
f.models.set("file", old);
f.owners.push(left, right);
for (let i = 0; i < 100; i++) f.retire("file", () => true);
assert.equal(f.tasks.size, 1, "Repeated retirement requests coalesce");
f.flush();
assert.equal(old.disposed, false);
assert.equal(left.changed.listeners.size, 1);
left.switch(undefined);
f.flush();
assert.equal(old.disposed, false, "The other split still owns its model");
right.close();
f.flush();
assert.equal(old.disposals, 1);
assert.equal(old.will.listeners.size, 0);
assert.equal(left.changed.listeners.size + right.disposed.listeners.size, 0);

const reopen = fixture(),
  protectedModel = model();
let retired = true;
reopen.models.set("file", protectedModel);
reopen.retire("file", () => retired);
retired = false;
reopen.flush();
assert.equal(protectedModel.disposed, false);
assert.equal(protectedModel.will.listeners.size, 0);

const replacement = fixture(),
  previous = model(),
  next = model();
replacement.models.set("file", previous);
replacement.retire("file", () => true);
replacement.models.set("file", next);
replacement.flush();
assert.equal(previous.disposals, 1);
assert.equal(next.disposed, false, "Only the captured model may be retired");

const external = fixture(),
  retiring = model(),
  active = owner(retiring);
external.models.set("file", retiring);
external.owners.push(active);
external.retire("file", () => true);
external.flush();
retiring.dispose();
assert.equal(active.changed.listeners.size, 0);
assert.equal(external.tasks.size, 0);
const canceled = fixture(),
  kept = model();
canceled.models.set("file", kept);
canceled.retire("file", () => true);
canceled.cancelAll();
canceled.flush();
assert.equal(kept.disposed, false);
assert.equal(kept.will.listeners.size, 0);
console.log(
  "Editor resource lifecycle passed: 200 previews bounded; dirty/saving/error/pinned/shared ownership; background reads; committed-only cleanup; rapid reopen; captured-model identity; deferred detach; coalescing and listener release.",
);
