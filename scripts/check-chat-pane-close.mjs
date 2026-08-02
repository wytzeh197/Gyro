import assert from "node:assert/strict";

import {
  chatGridReducer,
  createInitialChatGridState,
} from "../packages/ui/src/workbench-state.ts";

// Closing a chat pane has to survive everything that happens afterwards.
//
// The grid reducer is only half of a close: App.tsx keeps `activeSessionId`
// alongside it and treats "the active session has a pane" as an invariant, so a
// pane the reducer removed comes straight back if anything makes that session
// active again. This models both halves — the close handler, the pane-sync
// effect, and the auto-select inside `refreshSessions` — because the bug lives
// in how they interact and not in any one of them.

const PROJECT = "/w/gyro";
const sessions = [
  { id: "S", workspacePath: PROJECT },
  { id: "T", workspacePath: PROJECT },
];
const paneFor = (session) => ({
  kind: "session",
  paneId: `pane-${session.id}`,
  sessionId: session.id,
  workspacePath: session.workspacePath,
});

function createApp() {
  let grid = createInitialChatGridState();
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const app = {
    activeSessionId: undefined,
    suppressAutoSelect: true,
    closedPaneSessions: new Set(),
    dispatch(action) {
      grid = chatGridReducer(grid, action);
    },
    openPaneSessionIds() {
      return (grid.layouts[PROJECT]?.slots ?? [])
        .filter((pane) => pane?.kind === "session")
        .map((pane) => pane.sessionId);
    },
  };

  const syncEffect = () => {
    for (const layout of Object.values(grid.layouts)) {
      for (const pane of layout.slots) {
        if (pane?.kind === "session") {
          app.closedPaneSessions.delete(pane.sessionId);
        }
      }
    }
    const layout = grid.activeProjectKey
      ? grid.layouts[grid.activeProjectKey]
      : undefined;
    if (app.activeSessionId) {
      const requestedSession = sessionById.get(app.activeSessionId);
      const requestedPane = layout?.slots.find(
        (pane) =>
          pane?.kind === "session" && pane.sessionId === app.activeSessionId,
      );
      if (
        requestedSession &&
        !requestedPane &&
        !app.closedPaneSessions.has(app.activeSessionId)
      ) {
        app.dispatch({
          type: "select-pane",
          projectKey: PROJECT,
          mode: "replace",
          pane: paneFor(requestedSession),
        });
        return "reopened";
      }
    }
    const focusedPane = layout?.slots.find(
      (pane) => pane?.paneId === layout.focusedPaneId,
    );
    if (focusedPane?.kind === "session") {
      const session = sessionById.get(focusedPane.sessionId);
      if (session && app.activeSessionId !== session.id) {
        app.activeSessionId = session.id;
      }
    }
    return "stable";
  };

  app.settle = () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (syncEffect() === "stable") return;
    }
    throw new Error("pane sync never settled");
  };

  app.closePane = (pane) => {
    const paneLayout = grid.layouts[PROJECT];
    if (pane.kind === "session") app.closedPaneSessions.add(pane.sessionId);
    const nextPane =
      paneLayout?.slots.find(
        (candidate) =>
          candidate?.paneId === paneLayout.focusedPaneId &&
          candidate?.paneId !== pane.paneId,
      ) ??
      paneLayout?.slots.find(
        (candidate) => candidate && candidate.paneId !== pane.paneId,
      );
    if (nextPane?.kind === "session") {
      app.suppressAutoSelect = false;
      app.activeSessionId = nextPane.sessionId;
    } else {
      app.suppressAutoSelect = true;
      app.activeSessionId = undefined;
    }
    app.dispatch({
      type: "close-pane",
      projectKey: PROJECT,
      paneId: pane.paneId,
    });
    app.settle();
  };

  app.openSession = (sessionId) => {
    app.suppressAutoSelect = false;
    app.dispatch({
      type: "select-pane",
      projectKey: PROJECT,
      mode: "replace",
      pane: paneFor(sessionById.get(sessionId)),
    });
    app.activeSessionId = sessionId;
    app.settle();
  };

  app.refreshSessions = () => {
    if (!app.activeSessionId && !app.suppressAutoSelect) {
      app.activeSessionId = sessions.find(
        (session) => !app.closedPaneSessions.has(session.id),
      )?.id;
    }
    app.settle();
  };

  return app;
}

const app = createApp();
sessions.forEach((session, slotIndex) => {
  app.dispatch({
    type: "select-pane",
    projectKey: PROJECT,
    mode: "replace",
    pane: paneFor(session),
    slotIndex,
  });
});
app.activeSessionId = "T";
app.settle();
assert.deepEqual(
  app.openPaneSessionIds(),
  ["S", "T"],
  "both chats should open",
);

app.closePane(paneFor(sessions[0]));
assert.deepEqual(
  app.openPaneSessionIds(),
  ["T"],
  "closing one chat should leave the other",
);

app.closePane(paneFor(sessions[1]));
assert.deepEqual(
  app.openPaneSessionIds(),
  [],
  "closing the last chat empties the grid",
);

// The regression: anything that re-enables auto-select — focusing a pane,
// acknowledging a finished chat, a CLI attach — used to bring a closed chat
// window straight back the next time the session list refreshed.
app.suppressAutoSelect = false;
app.refreshSessions();
assert.deepEqual(
  app.openPaneSessionIds(),
  [],
  "a refresh must not reopen a chat the user closed",
);

// Closing is not the same as hiding: asking for the session again opens it,
// and it stays open through later refreshes.
app.openSession("S");
assert.deepEqual(
  app.openPaneSessionIds(),
  ["S"],
  "reopening a closed chat works",
);
app.suppressAutoSelect = false;
app.refreshSessions();
assert.deepEqual(
  app.openPaneSessionIds(),
  ["S"],
  "a reopened chat should survive a refresh",
);

// And closing it again still sticks, so the mark is not spent after one use.
app.closePane(paneFor(sessions[0]));
app.suppressAutoSelect = false;
app.refreshSessions();
assert.deepEqual(
  app.openPaneSessionIds(),
  [],
  "closing a reopened chat should stick too",
);

console.log("chat pane close checks passed");
