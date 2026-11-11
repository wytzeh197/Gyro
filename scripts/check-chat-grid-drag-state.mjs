import assert from "node:assert/strict";
import ts from "typescript";
import { readRepoSource } from "./read-repo-source.mjs";
import {
  chatGridReducer,
  chatPaneIdentity,
  chatProjectKey,
  resolveChatGridDropSlot,
  persistableChatGridState,
  sanitizeStoredChatGridState,
} from "../packages/ui/src/workbench-state.ts";

const PROJECT = "/fixture/Gyro";
const pane = (id, paneId = `pane:${id}`) => ({
  kind: "session",
  paneId,
  sessionId: id,
  workspacePath: PROJECT,
});
const stateOf = (slots, extra = {}) => ({
  activeProjectKey: PROJECT,
  layouts: {
    [PROJECT]: {
      projectKey: PROJECT,
      slots,
      focusedPaneId: slots.find(Boolean)?.paneId,
      arrangement: "grid",
      ...extra,
    },
  },
});
const slotsOf = (state) => state.layouts[PROJECT].slots;
const ids = (slots) => slots.filter(Boolean).map(chatPaneIdentity).sort();
const drop = (state, incoming, slotIndex, placement = {}) =>
  chatGridReducer(state, {
    type: "select-pane",
    projectKey: PROJECT,
    mode: "drop",
    pane: incoming,
    slotIndex,
    ...placement,
  });
const move = (state, moving, slotIndex, placement = {}) =>
  chatGridReducer(state, {
    type: "move-pane",
    projectKey: PROJECT,
    paneId: moving.paneId,
    slotIndex,
    ...placement,
  });
function assertLayout(state, expectedIds) {
  const slots = slotsOf(state);
  assert.equal(slots.length, 4);
  assert.deepEqual(ids(slots), expectedIds);
  assert.equal(
    new Set(slots.filter(Boolean).map((p) => p.paneId)).size,
    expectedIds.length,
  );
  assert.ok(
    slots.some((p) => p?.paneId === state.layouts[PROJECT].focusedPaneId),
  );
}

// Every occupancy pattern and pointer quadrant must preserve all open chats.
// Full layouts reject incoming chats instead of replacing one under a stale
// overlay. The resolver and reducer must agree on the actual landing cell.
for (let mask = 0; mask < 16; mask += 1) {
  const slots = Array.from({ length: 4 }, (_, index) =>
    mask & (1 << index) ? pane(String(index)) : null,
  );
  const state = stateOf(slots);
  const original = structuredClone(state);
  for (let target = 0; target < 4; target += 1) {
    const incoming = pane("incoming");
    const resolved = resolveChatGridDropSlot(slots, target);
    const result = drop(state, incoming, target);
    if (mask === 15) {
      assert.equal(resolved, undefined);
      assert.equal(
        result,
        state,
        "full quadrant drop preserves state and all chats",
      );
    } else {
      assert.ok(resolved);
      assertLayout(result, [...ids(slots), chatPaneIdentity(incoming)].sort());
      assert.equal(slotsOf(result)[resolved.targetIndex], incoming);
      if (resolved.displacedIndex !== undefined) {
        assert.equal(slotsOf(result)[resolved.displacedIndex], slots[target]);
      }
    }
    assert.deepEqual(state, original, "drop must not mutate its prior state");
  }

  // Sidebar drags preserve the original pane/key even if the supplied pane id
  // differs. Pane drags perform the same swap and retain every conversation.
  for (const moving of slots.filter(Boolean)) {
    for (let target = 0; target < 4; target += 1) {
      const from = slots.indexOf(moving);
      const bySession = drop(
        state,
        pane(moving.sessionId, "different-key"),
        target,
      );
      const byPane = move(state, moving, target);
      assert.deepEqual(bySession, byPane);
      assertLayout(bySession, ids(slots));
      assert.equal(slotsOf(bySession)[target], moving);
      if (from === target)
        assert.equal(bySession, state, "source quadrant is a strict no-op");
      else assert.equal(slotsOf(bySession)[from], slots[target]);
    }
  }
}

// Exhaustively exercise every before/after row boundary from every source,
// including layouts with holes. Model the expected order independently by
// removing the source and inserting beside the target's identity.
for (const arrangement of ["columns", "rows"]) {
  for (let mask = 1; mask < 16; mask += 1) {
    const slots = Array.from({ length: 4 }, (_, index) =>
      mask & (1 << index) ? pane(String(index)) : null,
    );
    const occupied = slots.filter(Boolean);
    const state = stateOf(slots, { arrangement });
    state.maximizedPaneId = occupied.at(-1).paneId;
    for (const moving of occupied) {
      for (const target of occupied) {
        for (const insertPosition of ["before", "after"]) {
          const placement = { insertPosition, arrangement };
          const remaining = occupied.filter((p) => p !== moving);
          if (target !== moving) {
            const targetPosition = remaining.indexOf(target);
            remaining.splice(
              targetPosition + (insertPosition === "after" ? 1 : 0),
              0,
              moving,
            );
          }
          const expected = target === moving ? occupied : remaining;
          const result = drop(
            state,
            pane(moving.sessionId, "different-key"),
            slots.indexOf(target),
            placement,
          );
          const byPane = move(state, moving, slots.indexOf(target), placement);
          assert.deepEqual(
            result,
            byPane,
            "sidebar and pane row placements agree",
          );
          assertLayout(result, ids(slots));
          assert.deepEqual(slotsOf(result).filter(Boolean), expected);
          if (expected.every((p, index) => p === occupied[index])) {
            assert.equal(
              result,
              state,
              "same/adjacent boundary preserves focus and maximization",
            );
          } else {
            assert.equal(result.layouts[PROJECT].focusedPaneId, moving.paneId);
            assert.equal(result.layouts[PROJECT].arrangement, arrangement);
            if (occupied.length === 2)
              assert.equal(
                result.layouts[PROJECT].splitDirection,
                arrangement === "rows" ? "vertical" : "horizontal",
              );
          }
        }
      }
    }
    for (const target of occupied) {
      for (const insertPosition of ["before", "after"]) {
        const incoming = pane("new");
        const result = drop(state, incoming, slots.indexOf(target), {
          insertPosition,
          arrangement,
        });
        if (occupied.length === 4) assert.equal(result, state);
        else {
          const expected = [...occupied];
          expected.splice(
            occupied.indexOf(target) + (insertPosition === "after" ? 1 : 0),
            0,
            incoming,
          );
          assertLayout(
            result,
            [...ids(slots), chatPaneIdentity(incoming)].sort(),
          );
          assert.deepEqual(slotsOf(result).filter(Boolean), expected);
          assert.equal(result.layouts[PROJECT].arrangement, arrangement);
          if (occupied.length === 1)
            assert.equal(
              result.layouts[PROJECT].splitDirection,
              arrangement === "rows" ? "vertical" : "horizontal",
            );
        }
      }
    }
  }
}

const initial = stateOf([pane("a"), pane("b"), null, null]);
initial.maximizedPaneId = "pane:b";
for (const invalid of [-1, 4, 10, 0.5, NaN, Infinity, -Infinity, null, "1"]) {
  assert.equal(resolveChatGridDropSlot(slotsOf(initial), invalid), undefined);
  assert.equal(drop(initial, pane("new"), invalid), initial);
  assert.equal(drop(initial, pane("a"), invalid), initial);
  assert.equal(move(initial, pane("a"), invalid), initial);
}
for (const incoming of [pane("new"), pane("a")]) {
  assert.equal(
    drop(initial, incoming, 2, { insertPosition: "before" }),
    initial,
    "stale row target in an empty cell is rejected",
  );
  assert.equal(
    drop(initial, incoming, 0, { insertPosition: "invalid" }),
    initial,
  );
}
assert.equal(move(initial, pane("a"), 2, { insertPosition: "after" }), initial);
assert.equal(move(initial, pane("missing"), 0), initial);
assert.equal(
  chatGridReducer(initial, {
    type: "move-pane",
    projectKey: "/fixture/elsewhere",
    paneId: "pane:a",
    slotIndex: 0,
  }),
  initial,
  "stale moves must not create/activate another project's layout",
);
const foreign = { ...pane("foreign"), workspacePath: "/fixture/elsewhere" };
const mixed = drop(initial, foreign, 0);
assertLayout(mixed, [...ids(slotsOf(initial)), chatPaneIdentity(foreign)].sort());
assert.equal(mixed.activeProjectKey, PROJECT);
assert.equal(slotsOf(mixed)[0].workspacePath, foreign.workspacePath);
const restoredMixed = sanitizeStoredChatGridState(persistableChatGridState(mixed));
assert.deepEqual(slotsOf(restoredMixed), slotsOf(mixed), "mixed workspace panes survive restart");
assert.equal(restoredMixed.layouts[PROJECT].focusedPaneId, mixed.layouts[PROJECT].focusedPaneId);
assert.equal(restoredMixed.layouts[PROJECT].arrangement, mixed.layouts[PROJECT].arrangement);
const refocused = chatGridReducer(restoredMixed, {
  type: "focus-pane", projectKey: PROJECT, paneId: foreign.paneId,
});
assert.equal(refocused.activeProjectKey, PROJECT);
assert.equal(refocused.layouts[PROJECT].focusedPaneId, foreign.paneId);
const sourceLayout = stateOf([foreign, null, null, null]);
sourceLayout.layouts[foreign.workspacePath] = {
  projectKey: foreign.workspacePath, slots: [foreign, null, null, null],
  focusedPaneId: foreign.paneId,
};
sourceLayout.layouts[PROJECT].slots = [pane("a"), null, null, null];
const copied = drop(sourceLayout, foreign, 1);
assert.notEqual(slotsOf(copied)[1].paneId, foreign.paneId, "each layout owns a distinct pane handle");
assert.equal(copied.layouts[foreign.workspacePath], sourceLayout.layouts[foreign.workspacePath]);
const full = stateOf(["a", "b", "c", "d"].map(id => pane(id)));
assert.equal(drop(full, foreign, 0), full, "cross-folder drops cannot evict a full grid");
assert.equal(
  drop(initial, pane("a"), 0),
  initial,
  "same-pane sidebar drop does not change focus/maximization",
);
assert.equal(move(initial, pane("a"), 0), initial);

// Distinct chats with colliding React keys receive unique ids; an existing
// chat always reuses its original pane even after a draft became a session.
const collided = drop(initial, pane("new", "pane:a"), 2);
assertLayout(collided, ["session:a", "session:b", "session:new"]);
assert.notEqual(slotsOf(collided)[2].paneId, "pane:a");
const formerlyDraft = stateOf([
  { ...pane("a"), paneId: "draft:old" },
  pane("b"),
  null,
  null,
]);
const movedDraft = drop(formerlyDraft, pane("a"), 1);
assert.equal(slotsOf(movedDraft)[1].paneId, "draft:old");
assert.equal(slotsOf(movedDraft)[0].sessionId, "b");

// Sparse/short caller arrays still resolve only within the four valid cells.
assert.deepEqual(resolveChatGridDropSlot([pane("a")], 0), {
  displacedIndex: 2,
  targetIndex: 0,
});
assert.equal(
  resolveChatGridDropSlot(
    [pane("a"), pane("b"), pane("c"), pane("d"), null],
    0,
  ),
  undefined,
);

// Execute production callbacks too: a reducer-only test cannot catch App
// accidentally selecting the source folder again after a successful drop.
const app = ts.createSourceFile("App.tsx", readRepoSource("apps/desktop/src/App.tsx", "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name, bindings) {
  let expression;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(app) === name) {
      expression = ts.isCallExpression(node.initializer)
        ? node.initializer.arguments[0] : node.initializer;
    }
    if (name === "onDropSession" && ts.isJsxAttribute(node) && node.name.getText(app) === name)
      expression = node.initializer.expression;
    ts.forEachChild(node, visit);
  };
  visit(app);
  assert.ok(expression, name);
  const js = ts.transpileModule("const handler = " + expression.getText(app) + "; return handler;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const chatGridRef = { current: stateOf([pane("a"), null, null, null]) };
const activeSessionIdRef = { current: "a" };
let workspace;
const bindings = {
  chatGridRef, activeSessionIdRef, chatProjectKey,
  suppressSessionAutoSelectRef: { current: false },
  sessions: [{ id: "a", workspacePath: PROJECT }, { id: "foreign", workspacePath: foreign.workspacePath }],
  acknowledgeFinishedChat() {}, dispatchWorkbench() {}, notify() {},
  setWorkspacePath(value) { workspace = value; },
  setActiveSessionId(value) { activeSessionIdRef.current = value; },
  refreshEvents: async () => {},
  chatPaneForSession: session => ({ ...pane(session.id), workspacePath: session.workspacePath }),
  dispatchChatGrid(action) {
    const next = chatGridReducer(chatGridRef.current, action);
    const changed = next !== chatGridRef.current;
    chatGridRef.current = next;
    return changed;
  },
};
bindings.focusChatPane = callback("focusChatPane", bindings);
callback("addSessionToChatGrid", bindings)("foreign");
assert.deepEqual(slotsOf(chatGridRef.current).filter(Boolean).map(p => p.sessionId), ["a", "foreign"]);
assert.equal(workspace, foreign.workspacePath);
bindings.focusChatPane(pane("a"));
bindings.focusChatPane(foreign);
assert.equal(chatGridRef.current.activeProjectKey, PROJECT);
assert.equal(chatGridRef.current.layouts[PROJECT].focusedPaneId, foreign.paneId);
callback("selectSession", bindings)("foreign");
assert.equal(chatGridRef.current.activeProjectKey, PROJECT, "sidebar selection keeps a visible mixed split");
const beforeForgedDrop = chatGridRef.current;
const dropCallback = callback("onDropSession", { ...bindings, displayedChatLayout: beforeForgedDrop.layouts[PROJECT] });
assert.equal(dropCallback("foreign", "/forged/path", 0), false);
assert.equal(chatGridRef.current, beforeForgedDrop);
assert.equal(dropCallback("foreign", foreign.workspacePath, 0), true);
assert.equal(slotsOf(chatGridRef.current)[0].workspacePath, foreign.workspacePath);
const diffRequests = [];
const loadPaneDiff = callback("loadInlineChangeDiff", {
  activeSession: { workspacePath: PROJECT }, workspacePath: PROJECT,
  workbench: { ide: { sourceControl: {} } },
  sourceControlForWorkspace: (_state, root) => {
    assert.equal(root, foreign.workspacePath);
    return { files: [] };
  },
  isTauriRuntime: () => true,
  invoke: async (_command, args) => { diffRequests.push(args.request); return { stdout: "diff" }; },
});
assert.equal(await loadPaneDiff("src/shared-name.ts", foreign.workspacePath), "diff");
assert.equal(diffRequests[0].workspacePath, foreign.workspacePath, "background diff reads its own folder");

for (const isFocused of [false, true]) {
  let sent;
  const pendingPaneSendRef = {};
  callback("requestSend", {
    pane: foreign, isFocused, pendingPaneSendRef, paneMode: "normal",
    paneDraftKey: foreign.sessionId, chatDraftModeRevisionsRef: { current: {} },
    focusChatPane: bindings.focusChatPane,
    sendDraft: (message, context) => { sent = { message, context }; },
  })("Use this folder", { workspacePath: PROJECT, sessionId: "a" });
  const outgoing = sent ?? pendingPaneSendRef.current;
  assert.equal(outgoing.context.workspacePath, foreign.workspacePath);
  assert.equal(outgoing.context.sessionId, foreign.sessionId);
}

console.log(
  "Chat grid drag state passed: exhaustive placement, capacity, cross-folder persistence, production focus/add/drop/send callbacks and stable pane identities.",
);
