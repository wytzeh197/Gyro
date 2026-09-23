import assert from "node:assert/strict";

import {
  chatGridReducer,
  createInitialChatGridState,
} from "../packages/ui/src/workbench-state.ts";

// "New session" in split view opens a draft in the selected pane. A sent draft
// keeps its pane id, so the grid must never let a later pane reuse an id that
// is still on screen: pane ids are React keys and the focus handle, and a
// collision merged the old and new chat into one pane.

const PROJECT = "/w/gyro";
const session = (id) => ({
  kind: "session",
  paneId: `session:${id}`,
  sessionId: id,
  workspacePath: PROJECT,
});
const draft = (paneId) => ({
  kind: "draft",
  paneId,
  draftKey: `new:${PROJECT}`,
  workspacePath: PROJECT,
});
const newSession = (paneId) => ({
  type: "select-pane",
  projectKey: PROJECT,
  mode: "replace",
  pane: draft(paneId),
});
const slots = (state) => state.layouts[PROJECT].slots;
const paneIds = (state) =>
  slots(state)
    .filter(Boolean)
    .map((p) => p.paneId);
const assertUniqueIds = (state) =>
  assert.equal(new Set(paneIds(state)).size, paneIds(state).length);

function splitOf(a, b) {
  let state = createInitialChatGridState();
  state = chatGridReducer(state, {
    type: "select-pane",
    projectKey: PROJECT,
    mode: "replace",
    pane: a,
  });
  return chatGridReducer(state, {
    type: "select-pane",
    projectKey: PROJECT,
    mode: "drop",
    insertPosition: "after",
    slotIndex: 0,
    pane: b,
  });
}

// New session replaces the selected (focused) pane, not another one.
{
  let state = splitOf(session("A"), session("B"));
  state = chatGridReducer(state, {
    type: "focus-pane",
    projectKey: PROJECT,
    paneId: "session:A",
  });
  state = chatGridReducer(state, newSession("draft:1"));
  assert.deepEqual(
    slots(state).map((p) => p?.paneId ?? null),
    ["draft:1", "session:B", null, null],
  );
  assert.equal(state.layouts[PROJECT].focusedPaneId, "draft:1");
}

// A sent draft keeps its pane id; a new draft reusing that id must not share
// it with the sent chat in the other pane.
{
  let state = splitOf(draft("draft:legacy"), session("B"));
  state = chatGridReducer(state, {
    type: "migrate-draft-pane",
    draftKey: `new:${PROJECT}`,
    sessionId: "A",
    workspacePath: PROJECT,
  });
  state = chatGridReducer(state, {
    type: "focus-pane",
    projectKey: PROJECT,
    paneId: "session:B",
  });
  state = chatGridReducer(state, newSession("draft:legacy"));
  assertUniqueIds(state);
  assert.equal(slots(state)[0].kind, "session");
  assert.equal(slots(state)[0].sessionId, "A");
  assert.equal(slots(state)[1].kind, "draft");
  assert.equal(state.layouts[PROJECT].focusedPaneId, slots(state)[1].paneId);
}

// Replacing the sent chat itself must remount: the draft cannot inherit the
// pane id (React key) of the chat it replaces.
{
  let state = splitOf(draft("draft:legacy"), session("B"));
  state = chatGridReducer(state, {
    type: "migrate-draft-pane",
    draftKey: `new:${PROJECT}`,
    sessionId: "A",
    workspacePath: PROJECT,
  });
  state = chatGridReducer(state, {
    type: "focus-pane",
    projectKey: PROJECT,
    paneId: "draft:legacy",
  });
  state = chatGridReducer(state, newSession("draft:legacy"));
  assertUniqueIds(state);
  assert.equal(slots(state)[0].kind, "draft");
  assert.notEqual(slots(state)[0].paneId, "draft:legacy");
  assert.equal(slots(state)[1].sessionId, "B");
}

// The project's unsent draft is already open in another pane: New Session
// focuses it there rather than opening it twice or collapsing the split.
{
  let state = splitOf(session("A"), draft("draft:1"));
  state = chatGridReducer(state, {
    type: "focus-pane",
    projectKey: PROJECT,
    paneId: "session:A",
  });
  state = chatGridReducer(state, newSession("draft:ignored"));
  assert.deepEqual(
    slots(state).map((p) => p?.paneId ?? null),
    ["session:A", "draft:1", null, null],
  );
  assert.equal(state.layouts[PROJECT].focusedPaneId, "draft:1");
}

// Clicking New Session while the draft is already the selected pane is a no-op.
{
  let state = splitOf(session("A"), draft("draft:1"));
  state = chatGridReducer(state, newSession("draft:ignored"));
  assert.deepEqual(
    slots(state).map((p) => p?.paneId ?? null),
    ["session:A", "draft:1", null, null],
  );
}

console.log("chat split new session: ok");
