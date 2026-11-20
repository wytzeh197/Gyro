import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  createInitialWorkbenchState,
  createTerminalPane,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

// Exercise the production callbacks without mounting the whole app or opening
// real sign-in sessions. Use the real reducer with mocked host dependencies.
const app = ts.createSourceFile(
  "App.tsx",
  readFileSync(new URL("../apps/desktop/src/App.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const terminalLaunch = ts.createSourceFile(
  "use-terminal-launch.ts",
  readFileSync(
    new URL("../apps/desktop/src/use-terminal-launch.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const live = ts.createSourceFile(
  "live-terminal-pane.tsx",
  readFileSync(
    new URL("../apps/desktop/src/live-terminal-pane.tsx", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => find(child, predicate));
}
function callback(name, bindings) {
  for (const source of [terminalLaunch, app]) {
    const node = find(
      source,
      (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name,
    );
    if (node?.initializer && ts.isCallExpression(node.initializer)) {
      return compile(node.initializer.arguments[0].getText(source), bindings);
    }
  }
  assert.fail(`Missing production callback: ${name}`);
}
function compile(expression, bindings) {
  const js = ts.transpileModule("const callback = " + expression, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return new Function(...Object.keys(bindings), js + "; return callback;")(
    ...Object.values(bindings),
  );
}

const profile = {
  id: "shell",
  displayName: "Shell",
  command: "zsh",
  args: [],
  readiness: "ready",
};
const loginId = "provider-anthropic-login-fixture";
function harness() {
  let state = {
    ...createInitialWorkbenchState(),
    terminalPanes: [
      {
        ...createTerminalPane(loginId, profile, "done"),
        output: "Login successful.",
      },
    ],
    selectedTerminalPaneId: loginId,
    isToolPanelOpen: false,
  };
  const created = [];
  const bindings = {
    config: {},
    workbench: state,
    terminalLaunchProfiles: (profiles) => profiles,
    providersForConfig: () => [],
    terminalProcessForProfile: () => ({
      command: "zsh",
      args: [],
      displayCommand: "zsh",
    }),
    workspaceActionRoot: "/fixture/project",
    isWorkspaceTrusted: () => true,
    createTerminalPane,
    workspaceRunMetadata: () => ({ workspaceMode: "local" }),
    dispatchWorkbench: (action) => {
      state = workbenchReducer(state, action);
    },
    setTerminalOutput: () => {},
    notify: () => {},
    isTauriRuntime: () => true,
    profileSupportsGovernance: () => false,
    terminalStatusFromSnapshot: (status) => status,
    terminalOutputRevisionRef: { current: {} },
    invoke: async (command, { request }) => {
      assert.equal(command, "create_terminal_pane");
      created.push(request);
      return {
        paneId: request.paneId,
        status: "running",
        output: "$ ",
        outputRevision: 1,
      };
    },
  };
  const launchTerminalPane = callback("launchTerminalPane", bindings);
  const userBindings = {
    launchTerminalPane,
    commandProfiles: [profile],
    defaultCommandProfiles: () => [profile],
    getCommandProfile: () => profile,
    notify: () => {},
    setActiveProfileId: () => {},
  };
  return { state: () => state, created, launchTerminalPane, userBindings };
}

for (const name of ["addTerminalPane", "runCommandProfile"]) {
  const test = harness();
  const launch = callback(name, test.userBindings);
  if (name === "addTerminalPane") await launch({ reveal: false });
  else {
    launch("shell", { reveal: false });
    await Promise.resolve();
    await Promise.resolve();
  }
  const state = test.state();
  assert.equal(test.created.length, 1);
  assert.notEqual(
    state.selectedTerminalPaneId,
    loginId,
    name + " must select the new pane",
  );
  assert.equal(state.selectedTerminalPaneId, test.created[0].paneId);
  assert.equal(
    state.isToolPanelOpen,
    false,
    "the companion must not open a duplicate drawer",
  );
  assert.equal(
    state.terminalPanes.find((pane) => pane.id === state.selectedTerminalPaneId)
      .output,
    "$ ",
  );
  assert.equal(
    state.terminalPanes.find((pane) => pane.id === loginId).output,
    "Login successful.",
  );
}
const background = harness();
await background.launchTerminalPane({
  profile,
  paneId: "background-task",
  reveal: false,
});
assert.equal(
  background.state().selectedTerminalPaneId,
  loginId,
  "background launches must not steal selection",
);
assert.equal(background.state().isToolPanelOpen, false);

const input = find(
  live,
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(live) === "terminal.onData",
);
assert.ok(input);
const writes = [];
const statusRef = { current: "done" };
const onData = compile(input.arguments[0].getText(live), {
  statusRef,
  pane: { id: loginId },
  onWriteRef: { current: (...args) => writes.push(args) },
});
for (const status of ["done", "failed", "restored"]) {
  statusRef.current = status;
  onData("\x1b[1;1R");
  onData("typed input");
}
assert.deepEqual(
  writes,
  [],
  "finished panes must not forward replay replies or keystrokes",
);
for (const status of ["running", "waiting"]) {
  statusRef.current = status;
  onData("live input");
}
assert.deepEqual(writes, [
  [loginId, "live input"],
  [loginId, "live input"],
]);
console.log(
  "Terminal launch regression passed: companion selection, preserved login history, background isolation, and live-only input.",
);
