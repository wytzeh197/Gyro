import { readRepoSource } from "./read-repo-source.mjs";
import assert from "node:assert/strict";

import ts from "typescript";
import {
  chatGridReducer,
  chatProjectKey,
  createChatProjectLayout,
} from "../packages/ui/src/workbench-state.ts";

// Execute the actual App callback, including its side effects. Reducer-only
// tests cannot catch a rejected drop changing the selected session/project.
const source = readRepoSource(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "App.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let callback;
let paneFactory;
let dispatchCallback;
function visit(node) {
  if (
    (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
    node.tagName.getText(tree) === "ChatGridSurface"
  ) {
    const attribute = node.attributes.properties.find(
      (property) =>
        ts.isJsxAttribute(property) &&
        property.name.getText(tree) === "onDropSession",
    );
    callback = attribute?.initializer?.expression?.getText(tree);
  }
  if (
    ts.isFunctionDeclaration(node) &&
    node.name?.getText(tree) === "chatPaneForSession"
  ) {
    paneFactory = node.getText(tree);
  }
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(tree) === "dispatchChatGrid" &&
    ts.isCallExpression(node.initializer)
  ) {
    dispatchCallback = node.initializer.arguments[0].getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(callback, "App no longer exposes its chat-grid drop callback");
assert.ok(paneFactory);
assert.ok(
  dispatchCallback,
  "App no longer has a synchronous chat-grid acceptance wrapper",
);
const transpile = (code) =>
  ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
const chatPaneForSession = new Function(
  transpile(paneFactory + "; return chatPaneForSession;"),
)();
const callbackJs = transpile("return (" + callback + ");");
const dispatchJs = transpile("return (" + dispatchCallback + ");");

const A = "/project/a";
const B = "/project/b";
const session = (id, workspacePath) => ({ id, workspacePath });
const pane = (id, workspacePath) =>
  chatPaneForSession(session(id, workspacePath));
const layout = (projectKey, slots) => ({
  projectKey,
  slots,
  focusedPaneId: slots.find(Boolean)?.paneId,
  arrangement: "columns",
});
function harness(
  initial,
  sessions,
  displayedProject = initial.activeProjectKey,
) {
  let state = initial;
  const effects = [];
  const chatGridRef = { current: initial };
  const activeSessionIdRef = {
    current:
      initial.layouts[initial.activeProjectKey]?.slots.find(Boolean)?.sessionId,
  };
  const dependencies = {
    chatGridRef,
    displayedChatLayout:
      initial.layouts[displayedProject] ??
      createChatProjectLayout(displayedProject),
    sessions,
    chatGridReducer,
    chatProjectKey,
    chatPaneForSession,
    activeSessionIdRef,
    setActiveSessionId(id) {
      effects.push(["session", id]);
    },
    setWorkspacePath(path) {
      effects.push(["workspace", path]);
    },
    refreshEvents(id) {
      effects.push(["refresh", id]);
      return Promise.resolve();
    },
    notify(...args) {
      effects.push(["notify", ...args]);
    },
    workspaceName: (path) => path.split("/").at(-1),
  };
  const dispatchDependencies = {
    chatGridRef,
    chatGridReducer,
    reduceChatGrid(action) {
      effects.push(["grid", action]);
      state = chatGridReducer(state, action);
    },
  };
  dependencies.dispatchChatGrid = new Function(
    ...Object.keys(dispatchDependencies),
    dispatchJs,
  )(...Object.values(dispatchDependencies));
  return {
    drop: new Function(...Object.keys(dependencies), callbackJs)(
      ...Object.values(dependencies),
    ),
    state: () => state,
    effects,
    activeSessionIdRef,
  };
}
function assertRejected(app, initial, invoke) {
  const originalRef = app.activeSessionIdRef.current;
  const effectCount = app.effects.length;
  assert.equal(invoke(), false);
  assert.equal(app.state(), initial);
  assert.equal(app.activeSessionIdRef.current, originalRef);
  assert.deepEqual(
    app.effects.slice(effectCount).filter(([type]) => type !== "notify"),
    [],
    "rejected drop must not select/refresh a session or mutate its project",
  );
}
function assertAccepted(app, id, path) {
  assert.equal(app.activeSessionIdRef.current, id);
  assert.ok(
    app.effects.some(([type, value]) => type === "session" && value === id),
  );
  assert.ok(
    app.effects.some(([type, value]) => type === "workspace" && value === path),
  );
  assert.ok(
    app.effects.some(([type, value]) => type === "refresh" && value === id),
  );
}

// Foreign chats land in the displayed layout while retaining their source
// workspace. Exercise every occupancy shape, valid slot, and invalid target.
for (let mask = 0; mask < 16; mask += 1) {
  const destination = Array.from({ length: 4 }, (_, index) =>
    mask & (1 << index) ? pane("a-" + index, A) : null,
  );
  const initial = {
    activeProjectKey: A,
    maximizedPaneId: destination.find(Boolean)?.paneId,
    layouts: {
      [A]: layout(A, destination),
      [B]: layout(B, [pane("b", B), null, null, null]),
    },
  };
  const incoming = session("incoming", B);
  for (const displayedSlot of [0, 1, 2, 3, 99]) {
    const app = harness(initial, [incoming]);
    const invoke = () => app.drop(incoming.id, B, displayedSlot);
    if (mask === 15 || displayedSlot === 99) {
      assertRejected(app, initial, invoke);
    } else {
      assert.equal(invoke(), true);
      assertAccepted(app, incoming.id, B);
      const next = app.state();
      assert.equal(next.activeProjectKey, A);
      // ChatGridSurface clears maximization after an accepted drop; this
      // callback preserves it so the surface does not toggle it back on.
      assert.equal(next.maximizedPaneId, initial.maximizedPaneId);
      assert.equal(next.layouts[B], initial.layouts[B]);
      const inserted = next.layouts[A].slots.find((item) => item?.sessionId === incoming.id);
      assert.ok(inserted);
      assert.equal(next.layouts[A].slots.filter(Boolean).length, destination.filter(Boolean).length + 1);
      assert.equal(next.layouts[A].focusedPaneId, inserted.paneId);
      assert.equal(inserted.workspacePath, B);
      for (const item of destination.filter(Boolean)) {
        assert.ok(next.layouts[A].slots.includes(item), "no existing chat is evicted");
      }
      const dispatched = app.effects.find(([type]) => type === "grid")[1];
      assert.equal(dispatched.projectKey, A);
      assert.equal(dispatched.slotIndex, displayedSlot);
      assert.equal(incoming.workspacePath, B);
    }
  }
}

// A chat already open in its source layout can also be displayed elsewhere.
// Its source pane identity/order stay intact; the displayed layout owns placement.
{
  const sourceSlots = [0, 1, 2, 3].map((index) => pane("b-" + index, B));
  sourceSlots[2] = { ...sourceSlots[2], paneId: "draft:migrated" };
  const initial = {
    activeProjectKey: A,
    layouts: {
      [A]: layout(A, [pane("a", A), null, null, null]),
      [B]: layout(B, sourceSlots),
    },
  };
  const app = harness(initial, [session("b-2", B)]);
  assert.equal(app.drop("b-2", B, 0, {
    insertPosition: "before", arrangement: "rows",
  }), true);
  assertAccepted(app, "b-2", B);
  assert.equal(app.state().activeProjectKey, A);
  assert.equal(app.state().layouts[B], initial.layouts[B]);
  assert.equal(app.state().layouts[A].slots[0].sessionId, "b-2");
  assert.equal(app.state().layouts[A].slots[0].workspacePath, B);
  assert.equal(app.state().layouts[A].arrangement, "rows");
}

// Rejected drops cannot change active session, workspace, or maximization.
{
  const slots = [0, 1, 2, 3].map((index) => pane("a-" + index, A));
  const initial = {
    activeProjectKey: A,
    maximizedPaneId: slots[2].paneId,
    layouts: { [A]: layout(A, slots) },
  };
  for (const [id, target, placement] of [
    ["new", 0, undefined],
    ["new", 3, { insertPosition: "after", arrangement: "columns" }],
    ["a-1", 1, undefined],
    ["a-0", 1, { insertPosition: "before", arrangement: "columns" }],
    ["a-0", 4, undefined],
    ["missing", 0, undefined],
  ]) {
    const app = harness(initial, [
      ...slots.map((item) => session(item.sessionId, A)),
      session("new", A),
    ]);
    assertRejected(app, initial, () => app.drop(id, A, target, placement));
    assert.equal(app.state().maximizedPaneId, slots[2].paneId);
  }
}

// Projectless chats can share the displayed layout without acquiring its path.
{
  const initial = {
    activeProjectKey: A,
    layouts: { [A]: layout(A, [pane("a", A), null, null, null]) },
  };
  const incoming = session("folderless", "");
  const app = harness(initial, [incoming]);
  assert.equal(app.drop("folderless", "", 3), true);
  assert.equal(app.state().activeProjectKey, A);
  assert.equal(app.state().layouts[A].slots[3].sessionId, "folderless");
  assert.equal(app.state().layouts[A].slots[3].workspacePath, "");
  assert.equal(incoming.workspacePath, "");
  assertAccepted(app, "folderless", "");
}

// Batched callbacks observe already-queued mutations, preventing a second drop
// from stealing focus after the first consumes the visible layout's final slot.
{
  const destination = [pane("a-0", A), pane("a-1", A), pane("a-2", A), null];
  const initial = {
    activeProjectKey: A,
    layouts: { [A]: layout(A, destination) },
  };
  const app = harness(initial, [session("first", B), session("second", B)]);
  assert.equal(app.drop("first", B, 3), true);
  const full = app.state();
  assert.equal(full.layouts[A].slots[3].sessionId, "first");
  assertRejected(app, full, () => app.drop("second", B, 0));
  assert.equal(app.activeSessionIdRef.current, "first");
  assert.equal(full.layouts[A].focusedPaneId, "session:first");
}

// Native drag hints must agree with the saved source session.
{
  const initial = {
    activeProjectKey: A,
    maximizedPaneId: "session:a",
    layouts: { [A]: layout(A, [pane("a", A), null, null, null]) },
  };
  for (const hint of ["", A, "/payload/forged-project"]) {
    const app = harness(initial, [session("foreign", B)]);
    assertRejected(app, initial, () => app.drop("foreign", hint, 0));
  }
  for (const hint of [B, B + "///"]) {
    const app = harness(initial, [session("foreign", B)]);
    assert.equal(app.drop("foreign", hint, 3), true);
    assert.equal(app.state().activeProjectKey, A);
    assert.equal(app.state().layouts[A].slots[3].workspacePath, B);
    assertAccepted(app, "foreign", B);
  }
}

console.log(
  "Chat project drop checks passed: actual App callback, visible-layout placement, source ownership, all occupancy patterns, rejected focus invariants, projectless chats, untrusted hints, and queued drops.",
);
