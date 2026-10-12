import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  chatGridReducer,
  chatProjectKey,
  createChatProjectLayout,
} from "../packages/ui/src/workbench-state.ts";

// Execute the actual App callback, including its side effects. Reducer-only
// tests cannot catch a rejected drop changing the selected session/project.
const source = readFileSync(
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

// All destination occupancy shapes must either append into their first free
// slot or refuse at capacity. The displayed project's quadrant/row placement
// must never address that destination.
for (let mask = 0; mask < 16; mask += 1) {
  const destination = Array.from({ length: 4 }, (_, index) =>
    mask & (1 << index) ? pane("b-" + index, B) : null,
  );
  const initial = {
    activeProjectKey: A,
    maximizedPaneId: "session:a",
    layouts: {
      [A]: layout(A, [pane("a", A), null, null, null]),
      [B]: layout(B, destination),
    },
  };
  const incoming = session("incoming", B);
  for (const displayedSlot of [0, 1, 2, 3, 99]) {
    const app = harness(initial, [incoming]);
    const invoke = () =>
      app.drop(incoming.id, B, displayedSlot, {
        insertPosition: "before",
        arrangement: "rows",
        splitDirection: "vertical",
      });
    if (mask === 15) {
      assertRejected(app, initial, invoke);
      assert.ok(
        app.effects.some(
          ([type, , title]) =>
            type === "notify" && title === "Chat layout is full",
        ),
      );
    } else {
      assert.equal(invoke(), true);
      assertAccepted(app, incoming.id, B);
      const next = app.state();
      assert.equal(next.activeProjectKey, B);
      assert.equal(next.maximizedPaneId, undefined);
      assert.equal(next.layouts[A], initial.layouts[A]);
      const freeSlot = destination.findIndex((item) => item === null);
      assert.equal(next.layouts[B].slots[freeSlot].sessionId, incoming.id);
      assert.equal(next.layouts[B].arrangement, "columns");
      destination.forEach((item, index) => {
        if (item) assert.equal(next.layouts[B].slots[index], item);
      });
      const dispatched = app.effects.find(([type]) => type === "grid")[1];
      assert.equal(dispatched.projectKey, B);
      assert.equal(dispatched.slotIndex, undefined);
      assert.equal(dispatched.insertPosition, undefined);
      assert.equal(dispatched.arrangement, undefined);
    }
  }
}

// A foreign chat already open in a full layout is focused there, with its
// original pane key/order preserved. No extra pane or eviction is permitted.
{
  const destination = [0, 1, 2, 3].map((index) => pane("b-" + index, B));
  destination[2] = { ...destination[2], paneId: "draft:migrated" };
  const initial = {
    activeProjectKey: A,
    layouts: {
      [A]: layout(A, [pane("a", A), null, null, null]),
      [B]: layout(B, destination),
    },
  };
  const app = harness(initial, [session("b-2", B)]);
  assert.equal(
    app.drop("b-2", B, 0, { insertPosition: "before", arrangement: "rows" }),
    true,
  );
  assertAccepted(app, "b-2", B);
  assert.equal(app.state().activeProjectKey, B);
  assert.equal(app.state().layouts[B].slots, destination);
  assert.equal(app.state().layouts[B].focusedPaneId, "draft:migrated");
  assert.equal(app.state().layouts[A], initial.layouts[A]);
}

// Same-project rejection cases cannot change active session, workspace or
// maximization, even when an incoming session still exists in the provider.
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

// Projectless chats get their own durable layout, never the displayed project
// or a path supplied in native drag bytes.
{
  const initial = {
    activeProjectKey: A,
    layouts: { [A]: layout(A, [pane("a", A), null, null, null]) },
  };
  const app = harness(initial, [session("folderless", "")]);
  assert.equal(
    app.drop("folderless", "", 3, {
      insertPosition: "before",
      arrangement: "rows",
    }),
    true,
  );
  const key = chatProjectKey("");
  assert.equal(app.state().activeProjectKey, key);
  assert.equal(app.state().layouts[key].slots[0].sessionId, "folderless");
  assert.equal(app.state().layouts[A], initial.layouts[A]);
  assertAccepted(app, "folderless", "");
}

// Two drop callbacks can run against the same rendered closure while React
// is batching updates. Acceptance must track already-queued mutations so a
// second chat cannot steal focus after the first consumed the final free slot.
{
  const destination = [pane("b-0", B), pane("b-1", B), pane("b-2", B), null];
  const initial = {
    activeProjectKey: A,
    layouts: {
      [A]: layout(A, [pane("a", A), null, null, null]),
      [B]: layout(B, destination),
    },
  };
  const app = harness(initial, [session("first", B), session("second", B)]);
  assert.equal(app.drop("first", B, 0), true);
  const full = app.state();
  assert.equal(full.layouts[B].slots[3].sessionId, "first");
  assertRejected(app, full, () => app.drop("second", B, 0));
  assert.equal(app.activeSessionIdRef.current, "first");
  assert.equal(full.layouts[B].focusedPaneId, "session:first");
}

// A native project hint must agree with the actual session. If it disagrees,
// the foreign-project preview no longer describes the drop. Empty hints name
// projectless chats; they cannot claim a chat that belongs to a project.
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
    assert.equal(app.state().activeProjectKey, B);
    assertAccepted(app, "foreign", B);
  }
}

console.log(
  "Chat project drop checks passed: real App callback and dispatch, rejected focus invariants, foreign-project safe append/existing focus, capacity, projectless chats, untrusted hints, queued drops.",
);
