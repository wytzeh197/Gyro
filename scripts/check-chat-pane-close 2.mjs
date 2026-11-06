import assert from "node:assert/strict";

import {
  chatGridReducer,
  createInitialChatGridState,
  sanitizeStoredChatGridState,
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
    firstSlotSessionId() {
      return grid.layouts[PROJECT]?.slots[0]?.sessionId;
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
    // Mirror App.tsx: never focus the pane being closed first — that race is
    // what emptied the split when the user clicked X on the left chat.
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
    if (nextPane) {
      app.dispatch({
        type: "focus-pane",
        projectKey: PROJECT,
        paneId: nextPane.paneId,
      });
    }
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
assert.equal(
  app.activeSessionId,
  "T",
  "the remaining split pane must become the active session",
);
// Compact: after unsplit, the survivor sits in the first slot so the grid
// cannot look empty while a chat is still open.
assert.equal(
  app.firstSlotSessionId(),
  "T",
  "closing a split pane should compact the remaining chat into the first slot",
);

app.closePane(paneFor(sessions[1]));
assert.deepEqual(
  app.openPaneSessionIds(),
  [],
  "closing the last chat empties the grid",
);
assert.equal(
  app.activeSessionId,
  undefined,
  "closing the last pane clears the active session",
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

// An optimistic draft can already have a second pane for the persisted
// session by the time the create response arrives. Identity changes must
// collapse those panes, keeping the focused view and its stable pane ID.
const draftPane = {
  kind: "draft",
  paneId: "pane-draft",
  draftKey: "draft-one",
  workspacePath: PROJECT,
};
const sessionPane = paneFor(sessions[0]);
for (const focusedPane of [draftPane, sessionPane]) {
  const state = {
    activeProjectKey: PROJECT,
    maximizedPaneId: sessionPane.paneId,
    layouts: {
      [PROJECT]: {
        projectKey: PROJECT,
        slots: [draftPane, sessionPane, null, null],
        focusedPaneId: focusedPane.paneId,
        arrangement: "rows",
        splitDirection: "vertical",
      },
    },
  };
  const migrated = chatGridReducer(state, {
    type: "migrate-draft-pane",
    draftKey: draftPane.draftKey,
    sessionId: sessionPane.sessionId,
    workspacePath: PROJECT,
  });
  assert.deepEqual(
    migrated.layouts[PROJECT].slots,
    [{ ...sessionPane, paneId: focusedPane.paneId }, null, null, null],
    "draft migration must show each session once and retain the focused pane",
  );
  assert.equal(migrated.layouts[PROJECT].focusedPaneId, focusedPane.paneId);
  assert.equal(migrated.layouts[PROJECT].arrangement, undefined);
  assert.equal(migrated.layouts[PROJECT].splitDirection, undefined);
  assert.equal(
    migrated.maximizedPaneId,
    focusedPane === sessionPane ? sessionPane.paneId : undefined,
    "deduplicating a maximized pane must leave the remaining chat visible",
  );

  const optimisticPane = {
    ...sessionPane,
    paneId: "optimistic-pane",
    sessionId: "optimistic",
  };
  const rekeyed = chatGridReducer(
    {
      ...state,
      layouts: {
        [PROJECT]: {
          ...state.layouts[PROJECT],
          slots: [optimisticPane, sessionPane, null, null],
          focusedPaneId:
            focusedPane === draftPane
              ? optimisticPane.paneId
              : sessionPane.paneId,
        },
      },
    },
    {
      type: "rekey-session-pane",
      fromSessionId: optimisticPane.sessionId,
      toSessionId: sessionPane.sessionId,
      workspacePath: PROJECT,
    },
  );
  assert.equal(rekeyed.layouts[PROJECT].slots.filter(Boolean).length, 1);
  assert.equal(
    rekeyed.layouts[PROJECT].slots[0].sessionId,
    sessionPane.sessionId,
  );
  assert.equal(
    rekeyed.layouts[PROJECT].slots[0].paneId,
    focusedPane === draftPane ? optimisticPane.paneId : sessionPane.paneId,
    "persisted session IDs must merge without replacing the focused pane",
  );
}

const otherProject = "/w/other";
const otherPane = { ...paneFor(sessions[1]), workspacePath: otherProject };
const backgroundCloseState = {
  activeProjectKey: otherProject,
  maximizedPaneId: otherPane.paneId,
  layouts: {
    [PROJECT]: {
      projectKey: PROJECT,
      slots: [sessionPane, null, null, null],
      focusedPaneId: sessionPane.paneId,
    },
    [otherProject]: {
      projectKey: otherProject,
      slots: [otherPane, null, null, null],
      focusedPaneId: otherPane.paneId,
    },
  },
};
const backgroundClosed = chatGridReducer(backgroundCloseState, {
  type: "close-pane",
  projectKey: PROJECT,
  paneId: sessionPane.paneId,
});
assert.equal(
  backgroundClosed.activeProjectKey,
  otherProject,
  "delayed pane close must preserve the user's current project",
);
assert.equal(backgroundClosed.maximizedPaneId, otherPane.paneId);
assert.equal(
  backgroundClosed.layouts[otherProject],
  backgroundCloseState.layouts[otherProject],
);
assert.equal(backgroundClosed.layouts[PROJECT].slots.filter(Boolean).length, 0);
for (const projectKey of [PROJECT, "/w/missing"]) {
  assert.equal(
    chatGridReducer(backgroundClosed, {
      type: "close-pane",
      projectKey,
      paneId: sessionPane.paneId,
    }),
    backgroundClosed,
    "closing a removed pane must be a no-op, even after its project disappears",
  );
}

const replacedMaximized = chatGridReducer(backgroundCloseState, {
  type: "select-pane",
  projectKey: otherProject,
  pane: { ...sessionPane, workspacePath: otherProject },
  mode: "replace",
});
assert.equal(
  replacedMaximized.maximizedPaneId,
  undefined,
  "replacing the maximized pane must not hide its replacement",
);
const switchedProject = chatGridReducer(backgroundCloseState, {
  type: "select-pane",
  projectKey: PROJECT,
  pane: sessionPane,
  mode: "replace",
});
assert.equal(
  switchedProject.maximizedPaneId,
  undefined,
  "a maximized pane from another project must not hide the selected chat",
);
assert.equal(
  chatGridReducer(backgroundCloseState, {
    type: "toggle-maximize-pane",
    paneId: "missing-pane",
  }),
  backgroundCloseState,
  "a stale maximize action must not hide the active grid",
);

const sparseState = {
  activeProjectKey: PROJECT,
  layouts: {
    [PROJECT]: {
      projectKey: PROJECT,
      slots: [null, null, sessionPane, null],
      focusedPaneId: sessionPane.paneId,
      splitDirection: "vertical",
      arrangement: "rows",
    },
  },
};
const restoredSparse =
  sanitizeStoredChatGridState(sparseState).layouts[PROJECT];
assert.deepEqual(
  restoredSparse.slots,
  [sessionPane, null, null, null],
  "restoring a lone pane must fill the first slot",
);
assert.equal(restoredSparse.arrangement, undefined);
assert.equal(restoredSparse.splitDirection, undefined);
const removedSession = chatGridReducer(
  {
    ...sparseState,
    layouts: {
      [PROJECT]: {
        ...sparseState.layouts[PROJECT],
        slots: [paneFor(sessions[1]), null, sessionPane, null],
      },
    },
  },
  { type: "remove-session-pane", sessionId: sessions[1].id },
);
assert.deepEqual(
  removedSession.layouts[PROJECT].slots,
  [sessionPane, null, null, null],
  "removing a session must expand the surviving pane",
);
assert.equal(removedSession.layouts[PROJECT].arrangement, undefined);
assert.equal(removedSession.layouts[PROJECT].splitDirection, undefined);

console.log("chat pane close and identity hardening checks passed");
