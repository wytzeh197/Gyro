import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

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
function callback(name, context) {
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name)
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(initializer, name);
  const js = ts.transpileModule(
    `const callback = ${initializer.getText(tree)}; callback;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  return vm.runInNewContext(js, { useCallback: (fn) => fn, ...context });
}

const draftKey = "new:/project";
let drafts = {
  [draftKey]: "Unsent first message",
  existing: "Existing chat draft",
};
let attachments = { [draftKey]: [{ id: "attachment" }] };
let selectedPane;
const context = {
  activeSession: { workspacePath: "/project" },
  activeSessionId: "existing",
  workspacePath: "/project",
  activeDraftKey: draftKey,
  chatGrid: { layouts: {} },
  chatProjectKey: (path) => path,
  suppressSessionAutoSelectRef: { current: false },
  activeSessionIdRef: { current: "existing" },
  SOLO_CHAT_PANE_ID: "solo",
  dispatchCompanion: () => {},
  dispatchWorkbench: () => {},
  dispatchChatGrid: (action) => {
    selectedPane = action.pane;
  },
  setIsStartingFirstTurn: () => {},
  setActiveSessionId: () => {},
  setDraftResetToken: () => {},
  setChatDrafts: (update) => {
    drafts = update(drafts);
  },
  setChatAttachments: (update) => {
    attachments = update(attachments);
  },
};
// Returning after another session replaced the draft pane must restore its text.
callback("startNewChat", context)();
assert.equal(selectedPane.draftKey, draftKey);
assert.equal(drafts[draftKey], "Unsent first message");
assert.equal(drafts.existing, "Existing chat draft");
assert.equal(attachments[draftKey][0].id, "attachment");
// Sending the first message must clear that project draft, not a global key.
callback("resetChatDraft", context)();
assert.equal(drafts[draftKey], "");
assert.equal(attachments[draftKey].length, 0);
assert.equal(drafts.existing, "Existing chat draft");
console.log("Chat draft navigation and send regression checks passed.");

// A manually opened folder has no session yet. Restore that explicit choice,
// including a chosen temp folder, without reopening removed projects.
const initialWorkspace = tree.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "loadInitialWorkspacePath",
);
assert.ok(initialWorkspace, "workspace restoration initializer");
const restoreWorkspace = (recent, removed) =>
  vm.runInNewContext(
    ts.transpileModule(
      `${initialWorkspace.getText(tree)}; loadInitialWorkspacePath();`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
    {
      loadRecentProjectPaths: () => recent,
      loadRemovedProjectPaths: () => removed,
    },
  );
assert.equal(
  restoreWorkspace(["/private/tmp/chosen", "/project"], []),
  "/private/tmp/chosen",
);
assert.equal(
  restoreWorkspace(["/removed", "/project"], ["/removed"]),
  "/project",
);
assert.equal(restoreWorkspace(["/removed"], ["/removed"]), undefined);
assert.equal(restoreWorkspace([], []), undefined);
assert.match(
  source,
  /useState<string \| undefined>\(\s*loadInitialWorkspacePath/,
);
console.log(
  "Manually opened workspace restart and removed-project checks passed.",
);

let workspace = "/old";
let activeSession = "old";
const suppressAutoSelect = { current: false };
const activeSessionRef = { current: "old" };
const oldPane = {
  paneId: "session:old",
  kind: "session",
  sessionId: "old",
  workspacePath: "/old",
};
const grid = {
  activeProjectKey: "/old",
  layouts: {
    "/old": {
      projectKey: "/old",
      slots: [oldPane],
      focusedPaneId: oldPane.paneId,
    },
  },
};
const activateProject = (action) => {
  if (action.type === "activate-project")
    grid.activeProjectKey = action.projectKey;
};
let releasePreparation;
let preparationStarted = false;
let preparationFinished = false;
const pendingPreparation = new Promise((resolve) => {
  releasePreparation = resolve;
});
const activationDeadline = setTimeout(() => releasePreparation(), 1000);
await callback("activateWorkspacePath", {
  normalizeProjectPath: (path) => path,
  MAX_RECENT_PROJECTS: 12,
  suppressSessionAutoSelectRef: suppressAutoSelect,
  activeSessionIdRef: activeSessionRef,
  setRemovedProjectPaths: () => {},
  setRecentProjectPaths: () => {},
  setActiveSessionId: (value) => {
    activeSession = value;
  },
  setSelectedWorkspaceRoot: () => {},
  setWorkspacePath: (value) => {
    workspace = value;
  },
  setFiles: () => {},
  dispatchWorkbench: () => {},
  dispatchChatGrid: activateProject,
  chatProjectKey: (path) => path,
  notify: () => {},
  workspaceName: (path) => path,
  isTauriRuntime: () => true,
  prepareWorkspace: async () => {
    preparationStarted = true;
    await pendingPreparation;
    preparationFinished = true;
  },
  refreshIdeServices: () => {},
})("/chosen");
clearTimeout(activationDeadline);
assert.equal(preparationStarted, true);
assert.equal(
  preparationFinished,
  false,
  "folder selection must settle before slow preparation, so its caller cannot navigate later",
);
releasePreparation();
await Promise.resolve();
let reconcileEffect;
function findReconcile(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(tree) === "useEffect" &&
    node.arguments[0]?.getText(tree).includes("const sessionById = new Map")
  ) {
    reconcileEffect = node.arguments[0];
  }
  ts.forEachChild(node, findReconcile);
}
findReconcile(tree);
assert.ok(reconcileEffect);
const reconciliation = ts.transpileModule(
  `(${reconcileEffect.getText(tree)})();`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const startupActions = [];
const restoredPane = {
  paneId: "session:restored",
  kind: "session",
  sessionId: "restored",
  workspacePath: "/restored",
};
const startup = {
  sessionsLoadedRef: { current: false },
  sessions: [],
  chatGrid: {
    activeProjectKey: "/restored",
    layouts: {
      "/restored": {
        projectKey: "/restored",
        slots: [restoredPane],
        focusedPaneId: restoredPane.paneId,
      },
    },
  },
  removedProjectPaths: [],
  activeSessionId: undefined,
  activeSessionIdRef: { current: undefined },
  closedChatPaneSessionsRef: { current: new Set() },
  chatProjectKey: (path) => path,
  dispatchChatGrid: (action) => startupActions.push(action),
  setActiveSessionId: (value) => {
    startup.activeSessionId = value;
  },
  setWorkspacePath: (value) => {
    startup.workspacePath = value;
  },
};
vm.runInNewContext(reconciliation, startup);
assert.equal(
  startupActions.length,
  0,
  "unloaded sessions cannot delete a restored pane",
);
startup.sessionsLoadedRef.current = true;
startup.sessions = [{ id: "restored", workspacePath: "/restored" }];
vm.runInNewContext(reconciliation, startup);
assert.equal(startup.activeSessionId, "restored");
assert.equal(startup.activeSessionIdRef.current, "restored");
assert.equal(startup.workspacePath, "/restored");
startup.sessions = [];
vm.runInNewContext(reconciliation, startup);
assert.ok(
  startupActions.some((action) => action.type === "remove-session-pane"),
  "an authoritative empty list still retires missing sessions",
);
for (const loaded of [false, true]) {
  const marker = { current: loaded };
  let replaced = false;
  await callback("refreshSessions", {
    sessionsLoadedRef: marker,
    removedProjectPaths: [],
    isTauriRuntime: () => true,
    invoke: async () => {
      throw new Error("fixture read failed");
    },
    withoutSideChatSessions: (value) => value,
    sideChatSessionIdsRef: { current: new Set() },
    setSessions: () => {
      replaced = true;
    },
  })();
  assert.equal(
    replaced,
    false,
    "read failure preserves prior sessions and panes",
  );
  assert.equal(
    marker.current,
    loaded,
    "failure must not count as first successful load",
  );
}
vm.runInNewContext(
  ts.transpileModule(`(${reconcileEffect.getText(tree)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    sessionsLoadedRef: { current: true },
    sessions: [{ id: "old", workspacePath: "/old" }],
    chatGrid: grid,
    removedProjectPaths: [],
    activeSessionId: activeSession,
    activeSessionIdRef: activeSessionRef,
    closedChatPaneSessionsRef: { current: new Set() },
    chatProjectKey: (path) => path,
    dispatchChatGrid: activateProject,
    setActiveSessionId: (value) => {
      activeSession = value;
    },
    setWorkspacePath: (value) => {
      workspace = value;
    },
  },
);
assert.equal(grid.activeProjectKey, "/chosen");
assert.equal(
  workspace,
  "/chosen",
  "focused old chat cannot undo an explicit folder choice",
);
assert.equal(activeSession, undefined);
await callback("refreshSessions", {
  sessionsLoadedRef: { current: true },
  isTauriRuntime: () => true,
  invoke: async () => [{ id: "old", workspacePath: "/old" }],
  withoutSideChatSessions: (sessions) => sessions,
  sideChatSessionIdsRef: { current: new Set() },
  visibleSessionsForProjects: (sessions) => sessions,
  removedProjectPaths: [],
  setSessions: () => {},
  suppressSessionAutoSelectRef: suppressAutoSelect,
  closedChatPaneSessionsRef: { current: new Set() },
  setActiveSessionId: (update) => {
    activeSession = update(activeSession);
  },
  setWorkspacePath: (update) => {
    workspace = update(workspace);
  },
})();
assert.equal(
  activeSession,
  undefined,
  "background refresh cannot reselect the previous chat",
);
assert.equal(
  activeSessionRef.current,
  undefined,
  "folder activation clears the live session owner synchronously",
);
assert.equal(
  workspace,
  "/chosen",
  "explicit workspace choice survives background completion",
);

// Stop must pause before awaiting the provider, so completion cannot race the queue.
const stoppedChatSessionsRef = { current: new Set() };
let resolveStop;
const stopChat = callback("stopChatSession", {
  stoppedChatSessionsRef,
  invoke: () =>
    new Promise((resolve) => {
      resolveStop = resolve;
    }),
  setQueueRetryTick: () => {},
  notify: () => {},
});
stopChat("existing");
assert.ok(stoppedChatSessionsRef.current.has("existing"));
resolveStop(true);
await Promise.resolve();
assert.ok(stoppedChatSessionsRef.current.has("existing"));
console.log(
  "Manual stop pauses queue delivery synchronously and stays paused.",
);
